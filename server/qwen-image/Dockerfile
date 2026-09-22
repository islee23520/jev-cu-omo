FROM pytorch/pytorch:2.14.0-cuda12.6-cudnn9-runtime@sha256:a77983eb7a3042ccf41a94da547a7f54a47fb70da15c36d67a8e8a329ebaa098

WORKDIR /srv

COPY requirements.txt /srv/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && pip install --no-cache-dir --break-system-packages -r requirements.txt \
    && apt-get purge -y git \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY app /srv/app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "300"]
