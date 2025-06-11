from flask import Flask, request
from twilio.twiml.messaging_response import MessagingResponse
import openai
import os
from dotenv import load_dotenv

load_dotenv()

openai.api_key = os.getenv("OPENAI_API_KEY")

app = Flask(__name__)
user_last_response = {}

@app.route("/whatsapp", methods=["POST"])
def whatsapp_reply():
    incoming_msg = request.values.get("Body", "").strip()
    sender = request.values.get("From", "")

    print(f"Message from {sender}: {incoming_msg}")

    kwargs = {
        "model": "gpt-3.5-turbo",
        "input": [
            {
                "role": "system",
                "content": (
                    "You are a professional, concise, and highly efficient assistant. But always response in English, doesn't matter in which language user speaks. "
                    "Always respond in clear, well-structured English, using no more than 20 words unless absolutely necessary. If the user asks for a detailed explanation, say 'I'm sorry, but I can only provide brief responses.'"
                )
            },
            {"role": "user", "content": incoming_msg}
        ]
    }

    if sender in user_last_response:
        resp = openai.responses.create(**kwargs, previous_response_id=user_last_response[sender])
    else:
        resp = openai.responses.create(**kwargs)

    reply_text = resp.output_text
    user_last_response[sender] = resp.id


    # Send back using Twilio
    twilio_resp = MessagingResponse()
    twilio_resp.message(reply_text)
    return str(twilio_resp)

if __name__ == "__main__":
    app.run(port=5000)
