# test.py
import json
from flask import Flask, request, Response
from formsg.sdk import FormSdk
from formsg.exceptions import WebhookAuthenticateException

app = Flask(__name__)

# Put your real values here (be sure you’re okay printing decrypted data in console)
FORM_SECRET_KEY = "dzUu2IL+H5Po42I4bp7il0LRDkU3nk6Au0pnuj/P1/o="
# IMPORTANT: For local tests with ngrok, set this to the ngrok https URL + /webhook
YOUR_WEBHOOK_URI = "https://console.v2.airbase.sg/p/pubwqd/tender-specs"

sdk = FormSdk("PRODUCTION")

@app.route("/healthz", methods=["GET"])
def healthz():
    return {"status": "ok"}, 200

@app.route("/webhook", methods=["POST"])
def webhook_route():
    # Parse JSON body
    try:
        posted_data = request.get_json(silent=True) or json.loads(request.data.decode("utf-8"))
    except Exception:
        return Response("Bad Request: invalid JSON", 400)

    # Signature must be present and valid
    sig = request.headers.get("X-FormSG-Signature")
    if not sig:
        return Response("Unauthorized: missing signature", 401)
    try:
        sdk.webhooks.authenticate(sig, YOUR_WEBHOOK_URI)
    except WebhookAuthenticateException as e:
        print("Auth failed:", e, flush=True)
        return Response("Unauthorized", 401)

    # Decrypt (no attachments version)
    try:
        responses = sdk.crypto.decrypt(FORM_SECRET_KEY, posted_data["data"])
    except KeyError:
        return Response("Bad Request: 'data' field missing", 400)

    print("Decrypted webhook data:", responses, flush=True)
    return Response(json.dumps({"message": "ok"}), 202)

if __name__ == "__main__":
    # Start a dev server so `python test.py` actually runs
    print("Starting Flask dev server on 3000  (health: /healthz)", flush=True)
    app.run(host="0.0.0.0", port=3000, debug=True)
