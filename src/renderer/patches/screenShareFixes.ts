/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { FluxDispatcher } from "@vencord/types/webpack/common";
import { currentSettings, DEFAULT_MAC_AUDIO_DELAY } from "renderer/components/ScreenSharePicker";
import { Settings, State } from "renderer/settings";
import { isLinux, isMac } from "renderer/utils";

import { addPatch } from "./shared";

const logger = new Logger("VesktopStreamFixes");

const PRESET_CUSTOM = 3;

// resolution 0 means source resolution
function getStreamQuality() {
    const { resolution = "720", frameRate = "30" } = State.store.screenshareQuality ?? {};
    return { resolution: Number(resolution), frameRate: Number(frameRate) };
}

function getTrackConstraints(resolution: number, frameRate: number): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = { frameRate: { ideal: frameRate, max: frameRate } };
    if (resolution) {
        constraints.width = { max: Math.round((resolution * 16) / 9) };
        constraints.height = { max: resolution };
    }
    return constraints;
}

// Roughly matches Discord's native 9Mbps for 1080p60, scaled by pixel rate
function getMaxBitrate(width: number, height: number, frameRate: number) {
    return Math.round(Math.min(Math.max(width * height * frameRate * 0.08, 3.5e6), 20e6));
}

// conn is the web MediaEngine's connection
function applyStreamQuality(conn: any, track: MediaStreamTrack) {
    const { resolution, frameRate } = getStreamQuality();
    const settings = track.getSettings();

    const width = settings.width ?? Math.round((resolution * 16) / 9);
    const height = settings.height ?? resolution;
    const size = { width, height, framerate: frameRate };
    const bitrateMax = getMaxBitrate(width, height, frameRate);

    conn.videoQualityManager.setGoliveQuality({ capture: size, encode: size, bitrateMax });

    const params = conn.videoStreamParameters.find((p: any) => p.quality === 100) ?? conn.videoStreamParameters[0];
    if (params) {
        params.maxResolution = resolution
            ? { type: "fixed", width: Math.round((resolution * 16) / 9), height: resolution }
            : { type: "source", width: 0, height: 0 };
    }

    logger.info("Applied stream quality", {
        width,
        height,
        frameRate,
        bitrateMax,
        track: settings
    });
}

addPatch({
    patches: [
        {
            // Web MediaEngine connection
            find: "BaseWebRTCConnection.updateVideoQuality",
            replacement: [
                {
                    // Discord derives quality from the track's constraints, ignoring frame rate and using a fixed bitrate
                    match: /(setDesktopInput=(\i)=>\{if\(null!=\2\)\{)let.{0,350}?this\.videoQualityManager\.setGoliveQuality\(\{encode:\i,capture:\i,bitrateMax:\i\}\)/,
                    replace: "$1$self.applyStreamQuality(this,$2.stream.getVideoTracks()[0])"
                },
                {
                    // Changing quality of an ongoing stream, e.g. via the Stream Settings context menu
                    match: /((\i)=this\.desktopInputPool\.get\((\i)\.desktopDescription\.id\);if\(null==\2\))return;/,
                    replace: "$1return $self.updateOngoingStream(this,$3);"
                }
            ]
        },
        {
            // Stereo stream audio (sending and receiving) and a higher audio bitrate are behind an experiment
            // Force enable it
            find: 'push("web_screen_share_audio")',
            replacement: {
                match: /\i\.getConfig\(\{location:"RTCConnection"\}\)\.enabled(?=&&\i\.push\("web_screen_share_audio"\))/,
                replace: "true"
            }
        },
        {
            // Stream context menu. The Stream Settings submenu is only shown in the native client
            find: '"stream-settings-audio-enable"',
            replacement: {
                match: /\i\.isPlatformEmbedded(?=\?\(0,\i\.jsx\)\(\i\.\i,\{id:"stream-settings")/,
                replace: "true"
            }
        }
    ],

    applyStreamQuality(conn: any, track: MediaStreamTrack) {
        try {
            applyStreamQuality(conn, track);
        } catch (e) {
            logger.error("Failed to apply stream quality", e);
        }
    },

    async updateOngoingStream(engine: any, { quality }: { quality?: { resolution: number; frameRate: number } }) {
        try {
            if (!quality) return;

            State.store.screenshareQuality = {
                resolution: String(quality.resolution),
                frameRate: String(quality.frameRate)
            };

            const conns: any[] = [];
            engine.eachConnection((c: any) => c.streamUserId === c.userId && conns.push(c), "stream");

            for (const conn of conns) {
                const track: MediaStreamTrack | undefined = conn.input.getVideoStream()?.getVideoTracks()[0];
                if (!track) continue;

                try {
                    await track.applyConstraints(getTrackConstraints(quality.resolution, quality.frameRate));
                    applyStreamQuality(conn, track);
                    conn.updateVideoQuality();
                    conn.handleVideo(conn.input.getVideoStreamId());
                } catch (e) {
                    logger.error("Failed to update stream quality", e);
                }
            }
        } catch (e) {
            logger.error("Failed to update ongoing stream", e);
        }
    }
});

async function getVirtmic() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioDevice = devices.find(({ label }) => label === "vencord-screen-share");
        return audioDevice?.deviceId;
    } catch {
        return null;
    }
}

// System audio is captured almost instantly while video still has to be encoded, so viewers hear
// the sound before they see it. Route the audio through a delay to line the two back up (macOS).
function delayAudioTrack(track: MediaStreamTrack, delayMs: number) {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const delay = ctx.createDelay(1);
    delay.delayTime.value = delayMs / 1000;

    const destination = ctx.createMediaStreamDestination();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(delay).connect(destination);

    const delayed = destination.stream.getAudioTracks()[0];

    // stop() on the delayed track must also release the system audio capture
    const stopDelayed = delayed.stop.bind(delayed);
    delayed.stop = () => {
        stopDelayed();
        track.stop();
        if (ctx.state !== "closed") ctx.close();
    };
    track.addEventListener("ended", () => delayed.stop());

    return delayed;
}

// Chromium's bandwidth estimate starts at 0.3 Mbps and barely climbs on Discord's servers even with no loss,
// so screen shares sat at 360p. Give the stream a floor and a start rate in the answer SDP, and raise the
// encoder's ceiling. About 6 Mbps for 1440p60, less for smaller presets; only for our screen tracks.
const screenTracks = new WeakSet<MediaStreamTrack>();

function getBitrateFloor() {
    const { resolution, frameRate } = getStreamQuality();
    const height = resolution || 1440;
    const kbps = (((height * 16) / 9) * height * frameRate * 0.027) / 1000;
    return Math.round(Math.min(Math.max(kbps, 1500), 6000));
}

const hasScreenTrack = (pc: RTCPeerConnection) => pc.getSenders().some(s => s.track && screenTracks.has(s.track));

const originalSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;
RTCPeerConnection.prototype.setRemoteDescription = function (
    this: RTCPeerConnection,
    desc?: RTCSessionDescriptionInit,
    ...rest: any[]
) {
    if (desc?.type === "answer" && desc.sdp && hasScreenTrack(this)) {
        try {
            const floor = getBitrateFloor();
            const start = Math.round(floor * 1.33);
            let inVideo = false;
            const sdp = desc.sdp
                .split("\r\n")
                .map(line => {
                    if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
                    if (
                        !inVideo ||
                        !/^a=fmtp:\d+ /.test(line) ||
                        line.includes("apt=") ||
                        line.includes("x-google-min-bitrate")
                    )
                        return line;
                    return `${line};x-google-min-bitrate=${floor};x-google-start-bitrate=${start}`;
                })
                .join("\r\n");
            desc = { type: desc.type, sdp };
            logger.info(`Stream bitrate floor ${floor} kbps, start ${start} kbps`);
        } catch (e) {
            logger.error("Failed to set the stream bitrate floor", e);
        }
    }
    return (originalSetRemoteDescription as any).call(this, desc, ...rest);
} as typeof RTCPeerConnection.prototype.setRemoteDescription;

const originalSetParameters = RTCRtpSender.prototype.setParameters;
RTCRtpSender.prototype.setParameters = function (this: RTCRtpSender, params: RTCRtpSendParameters, ...rest: any[]) {
    if (this.track && screenTracks.has(this.track)) {
        const ceiling = getBitrateFloor() * 2000;
        for (const encoding of params?.encodings ?? []) {
            if (encoding.maxBitrate && encoding.maxBitrate < ceiling) encoding.maxBitrate = ceiling;
        }
    }
    return originalSetParameters.call(this, params, ...rest);
} as typeof RTCRtpSender.prototype.setParameters;

const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
navigator.mediaDevices.getDisplayMedia = async function (opts) {
    // our picker runs while this is pending, so the quality is final once it resolves
    const stream = await originalGetDisplayMedia.call(this, opts);
    const { resolution, frameRate } = getStreamQuality();
    const track = stream.getVideoTracks()[0];
    screenTracks.add(track);

    if (currentSettings?.contentHint) track.contentHint = currentSettings.contentHint;

    try {
        await track.applyConstraints(getTrackConstraints(resolution, frameRate));
    } catch (e) {
        logger.error("Failed to apply constraints", e);
    }

    FluxDispatcher.dispatch({
        type: "STREAM_UPDATE_SETTINGS",
        preset: PRESET_CUSTOM,
        resolution,
        frameRate
    });

    const virtmicId = isLinux && (await getVirtmic());
    if (virtmicId) {
        const audio = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: {
                    exact: virtmicId
                },
                autoGainControl: false,
                echoCancellation: false,
                noiseSuppression: false,
                channelCount: 2,
                sampleRate: 48000,
                sampleSize: 16
            }
        });

        stream.getAudioTracks().forEach(t => stream.removeTrack(t));
        stream.addTrack(audio.getAudioTracks()[0]);
    }

    const delayMs = Settings.store.audio?.delay ?? DEFAULT_MAC_AUDIO_DELAY;
    const [audio] = stream.getAudioTracks();
    if (isMac && audio && delayMs > 0) {
        try {
            const delayed = delayAudioTrack(audio, delayMs);
            stream.removeTrack(audio);
            stream.addTrack(delayed);
            logger.info(`Delaying stream audio by ${delayMs} ms`);
        } catch (e) {
            logger.error("Failed to delay stream audio, sending it as is.", e);
        }
    }

    return stream;
};
