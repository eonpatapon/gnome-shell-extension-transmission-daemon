# gnome-shell-extension-transmission-daemon

Monitor a remote transmission-daemon or transmission-client using its RPC interface.

This extension supports only gnome-shell 3.4

![Screenshot](https://github.com/eonpatapon/gnome-shell-extension-transmission-daemon/raw/master/screenshot.png)

## Installation

### Via extensions.gnome.org

https://extensions.gnome.org/extension/365/transmission-daemon-indicator/

### Manual installation

    git clone git://github.com/eonpatapon/gnome-shell-extension-transmission-daemon.git
    cd gnome-shell-extension-transmission-daemon
    cp -r transmission-daemon@patapon.info ~/.local/share/gnome-shell/extensions

Restart the shell and then enable the extension.

## Configuration

### Transmission daemon

Enable the RPC interface in ``/etc/transmission-daemon/settings.json``.

See https://trac.transmissionbt.com/wiki/EditConfigFiles for complete documentation.

Set the host/port settings in the extension configuration.

### Transmission client

In the preferences enable the web client.