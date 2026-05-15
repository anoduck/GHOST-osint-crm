FROM komoot/photon:latest

USER root

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends wget bzip2 && \
    rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
