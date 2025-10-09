import os
import json
import logging
import sys
from dotenv import load_dotenv
from flask import Flask, request, Response
import formsg
from formsg.exceptions import WebhookAuthenticateException

# -------- Logging setup --------
DEBUG_WEBHOOK = os.getenv("DEBUG_WEBHOOK", "true").lower() in ("1", "true", "yes", "on")
LOG_LEVEL = logging.DEBUG if DEBUG_WEBHOOK else logging.INFO

# Remove all handlers associated with the root logger object (to avoid duplicate logs)
for handler in logging.root.handlers[:]:
    logging.root.removeHandler(handler)

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(message)s",
    force=True,  # Python 3.8+: forcibly reconfigures logging
)
log = logging.getLogger("webhook")
log.info("TEST: Logging initialized at module level")  # Test log

# -------- App & SDK --------
app = Flask(__name__)

# Attach our logger to Flask's logger and werkzeug logger
app.logger.handlers = log.handlers
app.logger.setLevel(log.level)
logging.getLogger("werkzeug").handlers = log.handlers
logging.getLogger("werkzeug").setLevel(log.level)

load_dotenv(".env")  # Ensure .env is loaded before accessing env vars

FORM_SECRET_KEY = os.getenv("FORM_SECRET_KEY")
if not FORM_SECRET_KEY:
    log.error("FORM_SECRET_KEY not set in environment. Please check your .env file.")
    raise RuntimeError("FORM_SECRET_KEY not set in environment.")

YOUR_WEBHOOK_URI = "https://console.v2.airbase.sg/p/pubwqd/tender-specs/webhook"
sdk = formsg.FormSdk("PRODUCTION")


@app.get("/healthz")
def healthz():
    log.info("Healthz endpoint hit")
    return {"status": "ok"}, 200


@app.get("/webhook-status")
def webhook_status():
    # Small diag endpoint you can open in a browser
    return {
        "status": "ok",
        "webhook_uri": YOUR_WEBHOOK_URI,
        "debug": DEBUG_WEBHOOK,
    }, 200


@app.post("/webhook")
def webhook_route():
    print(">>> /webhook endpoint hit")  # Fallback to stdout
    sys.stdout.flush()
    log.info('S1:received method=%s url=%s host=%s ctype=%s',
             request.method,
             request.url,
             request.headers.get("Host"),
             request.headers.get("Content-Type"))
    sys.stdout.flush()

    # [S2] parse JSON
    try:
        posted_data = request.get_json(silent=True)
        if posted_data is None:
            posted_data = json.loads(request.data.decode("utf-8"))
        top_keys = list(posted_data.keys())[:5]
        log.info('S2:json_ok keys=%s', top_keys)
        log.debug('S2:payload=%s', posted_data)
    except Exception as e:
        log.warning('S2:json_fail err=%s', e)
        return Response("Bad Request: invalid JSON", 400)

    # [S3] signature header present?
    signature = request.headers.get("X-FormSG-Signature")
    if not signature:
        log.warning('S3:sig_missing')
        return Response("Unauthorized: missing signature", 401)
    log.info('S3:sig_present')

    # [S4] authenticate signature (must match EXACT FormSG URL)
    try:
        sdk.webhooks.authenticate(signature, YOUR_WEBHOOK_URI)
        log.info('S4:auth_ok uri=%s', YOUR_WEBHOOK_URI)
    except WebhookAuthenticateException as e:
        log.warning('S4:auth_fail err=%s', e)
        return Response("Unauthorized", 401)
    except Exception as e:
        log.error('S4:auth_error err=%s', e)
        return Response("Internal Server Error: auth stage", 500)

    # [S5] decrypt (no attachments for your PoC)
    try:
        decrypted = sdk.crypto.decrypt(FORM_SECRET_KEY, posted_data["data"])
        if decrypted is None:
            log.error("S5:decrypt_none - Decryption failed or payload shape invalid. Check FORM_SECRET_KEY and payload.")
            return Response("Internal Server Error: decryption returned None", 500)
        # Keep payload out of logs; just confirm shape
        if isinstance(decrypted, dict):
            sample_keys = list(decrypted.keys())[:5]
            log.info('S5:decrypt_ok type=%s keys=%s', type(decrypted).__name__, sample_keys)
            log.debug('S5:decrypted_payload=%s', decrypted)
        else:
            log.info('S5:decrypt_ok type=%s', type(decrypted).__name__)
    except KeyError:
        log.warning("S5:decrypt_no_data_key")
        return Response("Bad Request: 'data' field missing", 400)
    except Exception as e:
        log.error('S5:decrypt_fail err=%s', e)
        return Response("Internal Server Error: decryption failed", 500)

    # [S6] success
    log.info('S6:done 202')
    return Response(json.dumps({"message": "ok"}), 202)


if __name__ == "__main__":
    # Dev-only; in prod use Gunicorn CMD below
    port = int(os.getenv("PORT", 3000))
    log.info("booting_dev port=%s webhook_uri=%s debug=%s", port, YOUR_WEBHOOK_URI, DEBUG_WEBHOOK)
    app.run(host="0.0.0.0", port=port)
