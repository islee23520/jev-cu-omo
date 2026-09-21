#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
uv venv --python 3.12 .venv-laya
UV_LINK_MODE=copy uv pip install --python .venv-laya/bin/python 'laya==0.3.4'
USE_TF=0 .venv-laya/bin/python -c 'import laya, torch; print(f"Laya {laya.__version__} / torch {torch.__version__}")'
