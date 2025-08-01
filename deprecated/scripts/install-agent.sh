#!/bin/bash

# Cslite Agent Installation Script
# Usage: curl -sSL https://agent.cslite.com/install | bash -s YOUR_API_KEY

set -e

API_KEY=$1
SERVER_URL=${CSLITE_SERVER:-"https://api.cslite.com"}
INSTALL_DIR="/opt/cslite"
SERVICE_NAME="cslite-agent"
CONFIG_FILE="/etc/cslite/agent.env"

if [ -z "$API_KEY" ]; then
    echo "Error: API key is required"
    echo "Usage: $0 <API_KEY>"
    exit 1
fi

echo "Installing Cslite Agent..."

# Detect OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
    if [ -f /etc/debian_version ]; then
        DISTRO="debian"
    elif [ -f /etc/redhat-release ]; then
        DISTRO="redhat"
    else
        DISTRO="unknown"
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="darwin"
    DISTRO="macos"
else
    echo "Unsupported operating system: $OSTYPE"
    exit 1
fi

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64)
        ARCH="amd64"
        ;;
    aarch64|arm64)
        ARCH="arm64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

BINARY_NAME="cslite-agent-${OS}-${ARCH}"
DOWNLOAD_URL="${SERVER_URL}/download/agent/${BINARY_NAME}"

# Create directories
sudo mkdir -p $INSTALL_DIR
sudo mkdir -p /etc/cslite
sudo mkdir -p /var/lib/cslite
sudo mkdir -p /var/log/cslite

# Download agent binary
echo "Downloading agent from $DOWNLOAD_URL..."
sudo curl -sSL $DOWNLOAD_URL -o $INSTALL_DIR/cslite-agent
sudo chmod +x $INSTALL_DIR/cslite-agent

# Create configuration
echo "Creating configuration..."
sudo tee $CONFIG_FILE > /dev/null <<EOF
AGENT_SERVER=$SERVER_URL
AGENT_KEY=$API_KEY
AGENT_HEARTBEAT_INTERVAL=60
AGENT_COMMAND_POLL_INTERVAL=30
AGENT_LOG_PATH=/var/log/cslite/agent.log
EOF

sudo chmod 600 $CONFIG_FILE

# Create systemd service
if [ "$OS" == "linux" ] && command -v systemctl &> /dev/null; then
    echo "Creating systemd service..."
    sudo tee /etc/systemd/system/$SERVICE_NAME.service > /dev/null <<EOF
[Unit]
Description=Cslite Agent
After=network.target

[Service]
Type=simple
User=root
ExecStart=$INSTALL_DIR/cslite-agent -config $CONFIG_FILE
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable $SERVICE_NAME
    sudo systemctl start $SERVICE_NAME

    echo "Agent installed and started successfully!"
    echo "Check status: sudo systemctl status $SERVICE_NAME"
    echo "View logs: sudo journalctl -u $SERVICE_NAME -f"

elif [ "$OS" == "darwin" ]; then
    # macOS launchd configuration
    echo "Creating launchd service..."
    sudo tee /Library/LaunchDaemons/com.cslite.agent.plist > /dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cslite.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$INSTALL_DIR/cslite-agent</string>
        <string>-config</string>
        <string>$CONFIG_FILE</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/cslite/agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/cslite/agent.error.log</string>
</dict>
</plist>
EOF

    sudo launchctl load /Library/LaunchDaemons/com.cslite.agent.plist

    echo "Agent installed and started successfully!"
    echo "Check status: sudo launchctl list | grep cslite"
    echo "View logs: tail -f /var/log/cslite/agent.log"
else
    echo "Manual startup required. Run: $INSTALL_DIR/cslite-agent -config $CONFIG_FILE"
fi

echo "Installation complete!"