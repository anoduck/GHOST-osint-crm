#!/bin/bash
set -e

PHOTON_DATA_DIR="/photon/photon_data"

if [ ! -d "$PHOTON_DATA_DIR" ] || [ -z "$(ls -A "$PHOTON_DATA_DIR" 2>/dev/null)" ]; then
    echo "======================================================="
    echo " Photon geocoder: first-time setup"
    echo " Downloading global geocoding dataset (~1.8GB)."
    echo " This is a one-time download — subsequent starts are instant."
    echo "======================================================="
    mkdir -p "$PHOTON_DATA_DIR"
    wget --progress=dot:giga \
        -O /tmp/photon-db.tar.bz2 \
        "https://download1.graphhopper.com/public/photon-db-latest.tar.bz2"
    echo "Extracting data..."
    tar -xjf /tmp/photon-db.tar.bz2 -C /photon/
    rm /tmp/photon-db.tar.bz2
    chown -R photon:photon "$PHOTON_DATA_DIR" 2>/dev/null || true
    echo "Photon data ready."
fi

echo "Starting Photon geocoder on :2322"
exec su -s /bin/bash photon -c "java -jar /photon/photon.jar -listen-ip 0.0.0.0 -listen-port 2322" 2>/dev/null || \
exec java -jar /photon/photon.jar -listen-ip 0.0.0.0 -listen-port 2322
