import os
import json
from dotenv import load_dotenv
from flask import Flask, request, Response
import formsg
from formsg.exceptions import WebhookAuthenticateException

app = Flask(__name__)
load_dotenv(".env")

FORM_SECRET_KEY = os.getenv("FORM_SECRET_KEY")

# IMPORTANT: This should be the FULL public URL of your webhook endpoint in THIS app.
# It must exactly match the URL configured in FormSG’s dashboard.
# Example: https://console.v2.airbase.sg/p/pubwqd/tender-specs/webhook
YOUR_WEBHOOK_URI = "https://console.v2.airbase.sg/p/pubwqd/tender-specs/webhook"

# "STAGING" or "PRODUCTION"
sdk = formsg.FormSdk("PRODUCTION")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}, 200


@app.post("/webhook")
def webhook_route():
    # Prefer get_json for correct content-type handling; fall back to raw bytes
    posted_data = request.get_json(request.data)
    if posted_data is None:
        try:
            sdk.webhooks.authenticate(
            request.headers["X-FormSG-Signature"], YOUR_WEBHOOK_URI
            )
        except WebhookAuthenticateException as e:
            print(e)
            return Response("Unauthorized", 401)

    signature = request.headers.get("X-FormSG-Signature")
    if not signature:
        return Response("Unauthorized: missing signature", 401)

    try:
        # Verify signature against the EXACT webhook URL you told FormSG
        sdk.webhooks.authenticate(signature, YOUR_WEBHOOK_URI)
    except WebhookAuthenticateException as e:
        print("Webhook auth error:", e, flush=True)
        return Response("Unauthorized", 401)

    # Decrypt (with attachments)
    try:
        decrypted = sdk.crypto.decrypt(FORM_SECRET_KEY, posted_data["data"])
    except KeyError:
        return Response("Bad Request: 'data' field missing", 400)

    print("Decrypted webhook data:", decrypted, flush=True)  # PoC logging
    return Response(json.dumps({"message": "ok"}), 202)


if __name__ == "__main__":
    # Make sure the app actually starts inside the container
    port = int(os.getenv("PORT", 3000))
    app.run(host="0.0.0.0", port=port)
