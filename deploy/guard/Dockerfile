FROM ghcr.io/openclaw/openclaw@sha256:14d1afacd0ba82ba0e9d1a14065694d6f574ac2914192169863acc37e74fc780
USER root
ARG SOURCE_COMMIT=unreleased-test
ADD --checksum=sha256:4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391 https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-arm64 /usr/local/bin/cloudflared
COPY deploy/guard/*.mjs deploy/guard/*.py /opt/clawbot-guard/
RUN node -e 'const fs=require("node:fs"),commit=process.argv[1];if(commit!=="unreleased-test"&&!/^[a-f0-9]{40}$/.test(commit))throw Error("Invalid source commit");fs.writeFileSync("/etc/clawbot-release.json",JSON.stringify({sourceCommit:commit}),{mode:0o444})' "$SOURCE_COMMIT" && \
    chmod 555 /usr/local/bin/cloudflared && chmod -R a-w /opt/clawbot-guard
USER 1000:1000
ENTRYPOINT ["node", "/opt/clawbot-guard/supervisor.mjs"]
CMD ["--test-publisher"]
