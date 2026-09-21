# pyright: reportMissingImports=false
import argparse
import json
import os
import sys
import time

os.environ.setdefault("USE_TF", "0")


def predict(engine, model, payload):
    started = time.perf_counter()
    if model == "router":
        result = engine.predict(payload["state"], payload["questions"])
    else:
        result = engine.predict(payload["state"], payload["questions"])
    result["latencyMs"] = round((time.perf_counter() - started) * 1000)
    result.setdefault("model", f"convaiinnovations/laya:{model}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="english", choices=("english", "multilingual", "typed-decisions", "router"))
    args = parser.parse_args()
    import laya

    if args.model == "router":
        engine = laya.Router(max_loaded=1)
    else:
        subfolder = None if args.model == "english" else args.model
        engine = laya.load("convaiinnovations/laya", subfolder=subfolder)
    print(json.dumps({"ready": True, "model": args.model}), flush=True)
    for line in sys.stdin:
        try:
            payload = json.loads(line)
            print(json.dumps(predict(engine, args.model, payload), ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
