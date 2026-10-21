ARG NAPCAT_BASE=registry.hub.docker.com/mlikiowa/napcat-docker@sha256:f611790ecffa23c3c182017d5cf68179dc24612403608cd835ad13d79642f1bd
FROM ${NAPCAT_BASE}

# Use the published v4.18.38 payload on the digest-pinned upstream QQ runtime.
# The source checkout is retained separately for inspection and adapter work.
COPY downloads/NapCat.Shell.v4.18.38.zip /app/NapCat.Shell.zip
COPY repos/NapCat-Docker/entrypoint.sh /app/entrypoint.sh
LABEL local.napcat.version="4.18.38" \
      local.napcat.source="bbd0d2aca3d470c20b33b1d4f95123335633bf26" \
      local.napcat.docker-source="42e4f9e8373c739f4d2ee599980ab8f87cff39b6"
