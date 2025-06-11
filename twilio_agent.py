import warnings
warnings.filterwarnings("ignore", category=FutureWarning)

import os, tempfile, io, time
from flask import Flask, request, send_file
from twilio.twiml.voice_response import VoiceResponse
import requests
import soundfile as sf
import whisper
import openai

from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
openai.api_key = os.environ.get("OPENAI_API_KEY")
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "default_voice_id")

whisper_model = whisper.load_model("tiny")
conversation_state = {}

def whisper_stt(audio_data, fs=16000):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        sf.write(tmp.name, audio_data, fs)
        result = whisper_model.transcribe(tmp.name)
        os.unlink(tmp.name)
    text = result["text"].strip()
    print(f"[STT] Transcription result: {text}")
    return text

def fetch_twilio_recording_with_retry(url, retries=5, delay=2):
    for attempt in range(retries):
        try:
            audio_resp = requests.get(url, auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN))
            if audio_resp.status_code == 200:
                return audio_resp
            else:
                print(f"[Retry {attempt+1}] Recording not ready. Status: {audio_resp.status_code}")
        except Exception as e:
            print(f"[Retry {attempt+1}] Error fetching recording: {e}")
        time.sleep(delay)
    raise Exception("Recording not available after retries.")

@app.route("/voice", methods=["GET", "POST"])
def voice():
    call_sid = request.values.get("CallSid", "unknown")
    from_num = request.values.get("From", "")
    print(f"[Call] Incoming call {call_sid} from {from_num}")
    conversation_state[call_sid] = {"last_response_id": None}
    
    resp = VoiceResponse()
    resp.say("Hello, I am your AI assistant. You can ask me any question. Please speak after the beep.", voice="alice")
    resp.record(
        action=request.url_root + "process_recording", method="POST",
        maxLength=30, timeout=5, playBeep=True, trim="trim-silence",
        recordingStatusCallback=request.url_root + "recording_status", recordingStatusCallbackMethod="POST"
    )
    return str(resp)

@app.route("/process_recording", methods=["GET", "POST"])
def process_recording():
    call_sid = request.values.get("CallSid", "unknown")
    recording_url = request.values.get("RecordingUrl")
    recording_sid = request.values.get("RecordingSid")
    recording_duration = request.values.get("RecordingDuration", "0")
    
    if recording_sid and (not recording_url or recording_url.endswith(".xml")):
        recording_url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Recordings/{recording_sid}.wav"

    print(f"[Record] Received recording for call {call_sid}. Duration: {recording_duration} sec. URL: {recording_url}")
    
    if not recording_url or recording_duration == "0":
        print(f"[Record] No audio captured (silence or error). Ending call.")
        resp = VoiceResponse()
        resp.say("I didn't catch that. Goodbye.")
        resp.hangup()
        cleanup_call_resources(call_sid)
        return str(resp)
    
    try:
        audio_resp = fetch_twilio_recording_with_retry(recording_url)
        print(f"[Record] Content-Type from Twilio: {audio_resp.headers.get('Content-Type')}")
    except Exception as e:
        print(f"[Error] Could not fetch recording from Twilio: {e}")
        resp = VoiceResponse()
        resp.say("Sorry, there was an error retrieving your recording. Goodbye.")
        resp.hangup()
        cleanup_call_resources(call_sid)
        return str(resp)

    audio_bytes = audio_resp.content
    try:
        audio_data, sample_rate = sf.read(io.BytesIO(audio_bytes))
    except Exception as e:
        print(f"[Error] Failed to read audio data: {e}")
        resp = VoiceResponse()
        resp.say("Sorry, I cannot process the audio. Goodbye.")
        resp.hangup()
        cleanup_call_resources(call_sid)
        return str(resp)

    if len(audio_data.shape) > 1 and audio_data.shape[1] > 1:
        audio_data = audio_data.mean(axis=1)

    if sample_rate != 16000:
        try:
            import librosa
            audio_data = librosa.resample(audio_data, orig_sr=sample_rate, target_sr=16000)
            sample_rate = 16000
        except ImportError:
            pass

    user_text = whisper_stt(audio_data, fs=sample_rate)
    if user_text == "":
        print("[STT] Transcription empty (user was silent). Hanging up.")
        resp = VoiceResponse()
        resp.say("It seems I didn't hear you say anything. Goodbye.")
        resp.hangup()
        cleanup_call_resources(call_sid)
        return str(resp)

    print(f"[User] Question: {user_text}")

    try:
        prev_resp_id = conversation_state.get(call_sid, {}).get("last_response_id")
        if prev_resp_id:
            ai_response = openai.responses.create(
                model="gpt-4",
                input=user_text,
                previous_response_id=prev_resp_id
            )
        else:
            ai_response = openai.responses.create(
                model="gpt-4",
                input=user_text
            )
    except Exception as e:
        print(f"[OpenAI] API call failed: {e}")
        resp = VoiceResponse()
        resp.say("I'm sorry, I cannot answer that right now. Let's try again later. Goodbye.")
        resp.hangup()
        cleanup_call_resources(call_sid)
        return str(resp)

    try:
        answer_text = ai_response.output[0].content[0].text
    except Exception:
        answer_text = ai_response.get("output", [{}])[0].get("content", [{}])[0].get("text", "")
    answer_text = answer_text.strip()
    print(f"[OpenAI] Response (id={ai_response.id}): {answer_text}")
    conversation_state.setdefault(call_sid, {})["last_response_id"] = ai_response.id

    try:
        tts_endpoint = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
        headers = {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json"
        }
        tts_payload = {"text": answer_text}
        tts_res = requests.post(tts_endpoint, json=tts_payload, headers=headers)
        tts_res.raise_for_status()
    except Exception as e:
        print(f"[TTS] ElevenLabs API error: {e}")
        resp = VoiceResponse()
        resp.say("Sorry, I'm having issues speaking the answer. Goodbye.")
        resp.hangup()
        cleanup_call_resources(call_sid)
        return str(resp)

    audio_filename = f"tts_{call_sid}.mp3"
    with open(audio_filename, "wb") as f:
        f.write(tts_res.content)
    print(f"[TTS] Audio generated and saved to {audio_filename} ({len(tts_res.content)} bytes)")

    resp = VoiceResponse()
    audio_url = request.url_root + f"audio/{audio_filename}"
    resp.play(audio_url)
    resp.pause(length=1)
    resp.say("You can ask another question after the beep.", voice="alice")
    resp.record(
        action=request.url_root + "process_recording", method="POST",
        maxLength=30, timeout=5, playBeep=True, trim="trim-silence",
        recordingStatusCallback=request.url_root + "recording_status", recordingStatusCallbackMethod="POST"
    )
    return str(resp)

@app.route("/recording_status", methods=["GET", "POST"])
def recording_status():
    call_sid = request.values.get("CallSid", "unknown")
    rec_event = request.values.get("RecordingStatusCallbackEvent") or request.values.get("RecordingStatus")
    rec_duration = request.values.get("RecordingDuration", "")
    rec_source = request.values.get("RecordingSource", "")
    digits = request.values.get("Digits", "")
    print(f"[RecordCallback] Call {call_sid}: Event '{rec_event}', Duration {rec_duration}, Source {rec_source}, Digits '{digits}'")

    if rec_event == "absent" or digits == "hangup":
        print(f"[RecordCallback] No recording captured. Cleaning up.")
        cleanup_call_resources(call_sid)
    return ("", 204)

@app.route("/audio/<path:filename>", methods=["GET"])
def serve_audio(filename):
    if os.path.exists(filename):
        return send_file(filename, mimetype="audio/mpeg")
    else:
        return ("File not found", 404)

def cleanup_call_resources(call_sid):
    audio_file = f"tts_{call_sid}.mp3"
    try:
        if os.path.exists(audio_file):
            os.remove(audio_file)
            print(f"[Cleanup] Removed audio file {audio_file}")
    except Exception as e:
        print(f"[Cleanup] Error removing {audio_file}: {e}")
    conversation_state.pop(call_sid, None)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
