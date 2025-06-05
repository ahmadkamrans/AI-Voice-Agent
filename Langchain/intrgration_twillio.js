// Continuing in index.js (after express above)

const WebSocket = require("ws");
const base64 = require("base64-js");
const { Writable } = require("stream");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { SpeechClient } = require("@google-cloud/speech");         // or ElevenLabs STT
const { TextToSpeechClient } = require("@google-cloud/text-to-speech"); // or ElevenLabs TTS
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // set in your environment
});

const vad = require("node-webrtcvad"); // a Node wrapper around webrtcvad (install with `npm install node-webrtcvad`)

// Globals per call (in a production setup, you’d keep a map of callSid → buffers/queues)
let inboundBuffer = [];        // array of Buffer chunks (PCM16)
let speechActive = false;
let silenceCounter = 0;
const SILENCE_LIMIT_FRAMES = Math.floor((3 * 1000) / 30); // ~3 sec silence if 30ms per frame

// Simple in-memory queue for outbound frames
const ttsQueue = []; 

// Create the WS server
const wss = new WebSocket.Server({ port: WS_PORT, path: "/media" });
console.log(`WebSocket server listening on ws://0.0.0.0:${WS_PORT}/media`);

wss.on("connection", (ws, req) => {
  console.log("Media Stream connected");

  // For each connection, spin up a “sender” that looks at ttsQueue
  // and pushes any new frames to Twilio. In a production environment,
  // you’d key that queue per-callSid so multiple calls can run simultaneously.
  let callAlive = true;
  (async function sender() {
    while (callAlive) {
      if (ttsQueue.length > 0) {
        // Pop the next array of frames (each frame is a Base64 JSON object)
        const nextBatch = ttsQueue.shift();
        for (const frame of nextBatch) {
          ws.send(JSON.stringify(frame));
        }
      } else {
        // If nothing’s queued, wait a tiny bit
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  })();

  ws.on("message", async (data) => {
    const msg = JSON.parse(data);

    if (msg.event === "start") {
      // Twilio is telling us “the Media Stream is open.”
      console.log("[Twilio Stream] START");
      return;
    }

    if (msg.event === "media") {
      const media = msg.media;
      if (media.track === "inbound_audio") {
        // 1) Decode Base64 → Buffer (raw PCM16 @ 8kHz, mono)
        const pcmBuffer = Buffer.from(media.payload, "base64");
        // 2) Run VAD on that frame (30ms of audio = 240 samples @ 8kHz; 480 bytes)
        const isSpeech = vad.processAudio(pcmBuffer, 8000);

        if (isSpeech) {
          if (!speechActive) {
            speechActive = true;
            inboundBuffer = [];
            silenceCounter = 0;
          }
          inboundBuffer.push(pcmBuffer);
        } else {
          if (speechActive) {
            silenceCounter++;
            if (silenceCounter > SILENCE_LIMIT_FRAMES) {
              // End of utterance
              speechActive = false;

              // Concatenate all buffered PCM16 chunks
              const userPCM = Buffer.concat(inboundBuffer);
              inboundBuffer = [];

              // 3) Write userPCM → a temp WAV file (8kHz, mono, 16-bit)
              const tmpWavPath = path.join(__dirname, "tmp", `user_${Date.now()}.wav`);
              await writeBufferToWav(userPCM, tmpWavPath);

              // 4) STT on that WAV → transcription (can use ElevenLabs STT or Google Speech)
              const transcription = await runStt(tmpWavPath);
              console.log("[STT] Caller said:", transcription);

              // 5) LLM → generate response
              const responseText = await runOpenAI(transcription);
              console.log("[LLM] Answer:", responseText);

              // 6) TTS (ElevenLabs or Google) → raw PCM16 @ 8kHz
              const pcm8 = await runTts(responseText);

              // 7) Chop PCM into 20ms frames (160 samples ⇒ 320 bytes)
              const outboundFrames = chunkPcmToBase64(pcm8, 160);

              // 8) Enqueue the outgoing frames so “sender” can pick them up
              ttsQueue.push(outboundFrames);
            }
          }
        }
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("[Twilio Stream] STOP");
      callAlive = false;
      ws.close();
      return;
    }
  });

  ws.on("close", () => {
    console.log("WebSocket closed");
    callAlive = false;
  });
});


// ---------------
// Helper Routines
// ---------------

// 1) Write a Buffer of raw PCM16 @ 8kHz into a WAV container.
//    You can use “wav” or “node-wav” to do this, or call `ffmpeg` as a child process.
//
// For simplicity, here’s a quick ffmpeg-based function:
async function writeBufferToWav(pcmBuffer, wavPath) {
  const rawPath = wavPath.replace(/\.wav$/, ".raw");
  await fs.promises.writeFile(rawPath, pcmBuffer);
  return new Promise((resolve, reject) => {
    const ffmpeg = require("child_process").spawn("ffmpeg", [
      "-y",
      "-f", "s16le",
      "-ar", "8000",
      "-ac", "1",
      "-i", rawPath,
      wavPath,
    ]);
    ffmpeg.on("error", reject);
    ffmpeg.on("exit", (code) => {
      if (code === 0) {
        fs.unlinkSync(rawPath);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

// 2) runStt: Use ElevenLabs STT or Google Speech-to-Text
async function runStt(wavPath) {
  // EXAMPLE: Google Cloud Speech-to-Text
  const speechClient = new SpeechClient();
  const file = await fs.promises.readFile(wavPath);
  const audioBytes = file.toString("base64");
  const request = {
    audio: { content: audioBytes },
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 8000,
      languageCode: "en-US",
    },
  };
  const [response] = await speechClient.recognize(request);
  const transcription = response.results
    .map((res) => res.alternatives[0].transcript)
    .join("\n");
  return transcription;
}

// 3) runOpenAI: Call GPT-3.5-Turbo
async function runOpenAI(prompt) {
  const completion = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content:
          "You are a professional, concise, highly efficient assistant. Always reply in clear English, ≤20 words unless necessary.",
      },
      { role: "user", content: prompt },
    ],
  });
  return completion.choices[0].message.content.trim();
}

// 4) runTts: Use ElevenLabs TTS or Google TTS
async function runTts(text) {
  // EXAMPLE: ElevenLabs streaming TTS → save as MP3 → ffmpeg → raw PCM16 @ 8kHz
  const elUrl = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_LABS_VOICE_ID}/stream`;
  const elHeaders = {
    "xi-api-key": process.env.ELEVEN_LABS_API_KEY,
    Accept: "audio/mpeg",
  };
  // 4a) Get MP3
  const response = await axios.post(
    elUrl,
    { text: text, model_id: "eleven_monolingual_v1" },
    { responseType: "stream", headers: elHeaders }
  );

  // 4b) Pipe the MP3 stream to a temp file
  const tmpMp3Path = path.join(__dirname, "tmp", `tts_${Date.now()}.mp3`);
  const writer = fs.createWriteStream(tmpMp3Path);
  response.data.pipe(writer);
  await new Promise((r, e) => writer.on("finish", r).on("error", e));

  // 4c) ffmpeg: mp3 → PCM16 @ 8kHz
  const tmpPcmPath = tmpMp3Path.replace(/\.mp3$/, ".pcm");
  await new Promise((resolve, reject) => {
    const ffmpeg = require("child_process").spawn("ffmpeg", [
      "-y",
      "-i",
      tmpMp3Path,
      "-ar",
      "8000",
      "-ac",
      "1",
      "-f",
      "s16le",
      tmpPcmPath,
    ]);
    ffmpeg.on("exit", (code) => {
      if (code === 0) {
        fs.unlinkSync(tmpMp3Path);
        resolve();
      } else {
        reject(new Error(`ffmpeg failed with code ${code}`));
      }
    });
  });

  // 4d) Load PCM16 into a Buffer and return
  const pcmBuffer = await fs.promises.readFile(tmpPcmPath);
  fs.unlinkSync(tmpPcmPath);
  return pcmBuffer; // Buffer of s16le@8kHz
}

// 5) chunkPcmToBase64: Chop into 20ms frames (160 samples @ 8000Hz = 320 bytes)
function chunkPcmToBase64(pcmBuffer, frameSizeSamples) {
  const frameBytes = frameSizeSamples * 2; // 2 bytes per sample
  const frames = [];
  for (let offset = 0; offset < pcmBuffer.length; offset += frameBytes) {
    let slice = pcmBuffer.slice(offset, offset + frameBytes);
    if (slice.length < frameBytes) {
      // pad with zeros if necessary
      slice = Buffer.concat([slice, Buffer.alloc(frameBytes - slice.length)]);
    }
    const b64 = slice.toString("base64");
    frames.push({
      event: "media",
      media: {
        track: "outbound_audio",
        payload: b64,
      },
    });
  }
  return frames;
}
