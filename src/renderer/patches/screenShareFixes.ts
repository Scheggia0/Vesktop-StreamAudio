/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { currentSettings, DEFAULT_MAC_AUDIO_DELAY } from "renderer/components/ScreenSharePicker";
import { Settings, State } from "renderer/settings";
import { isLinux, isMac } from "renderer/utils";

const logger = new Logger("VesktopStreamFixes");

if (isMac) {
    const original = navigator.mediaDevices.getDisplayMedia;

    // System audio is captured almost instantly while video still has to be encoded, so viewers hear
    // the sound before they see it. Route the audio through a delay to line the two back up.
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

    navigator.mediaDevices.getDisplayMedia = async function (opts) {
        const stream = await original.call(this, opts);

        const delayMs = Settings.store.audio?.delay ?? DEFAULT_MAC_AUDIO_DELAY;
        const [audio] = stream.getAudioTracks();
        if (!audio || delayMs <= 0) return stream;

        try {
            const delayed = delayAudioTrack(audio, delayMs);
            stream.removeTrack(audio);
            stream.addTrack(delayed);
            logger.info(`Delaying stream audio by ${delayMs} ms`);
        } catch (e) {
            logger.error("Failed to delay stream audio, sending it as is.", e);
        }

        return stream;
    };
}

if (isLinux) {
    const original = navigator.mediaDevices.getDisplayMedia;

    async function getVirtmic() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioDevice = devices.find(({ label }) => label === "vencord-screen-share");
            return audioDevice?.deviceId;
        } catch (error) {
            return null;
        }
    }

    navigator.mediaDevices.getDisplayMedia = async function (opts) {
        const stream = await original.call(this, opts);
        const id = await getVirtmic();

        const frameRate = Number(State.store.screenshareQuality?.frameRate ?? 30);
        const height = Number(State.store.screenshareQuality?.resolution ?? 720);
        const width = Math.round(height * (16 / 9));
        const track = stream.getVideoTracks()[0];

        track.contentHint = String(currentSettings?.contentHint);

        const constraints = {
            ...track.getConstraints(),
            frameRate: { min: frameRate, ideal: frameRate },
            width: { min: 640, ideal: width, max: width },
            height: { min: 480, ideal: height, max: height },
            advanced: [{ width: width, height: height }],
            resizeMode: "none"
        };

        track
            .applyConstraints(constraints)
            .then(() => {
                logger.info("Applied constraints successfully. New constraints: ", track.getConstraints());
            })
            .catch(e => logger.error("Failed to apply constraints.", e));

        if (id) {
            const audio = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: {
                        exact: id
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

        return stream;
    };
}
