# gnome-shell-extension-transmission-daemon

Monitor a remote transmission-daemon or transmission GTK app using its RPC interface.

This extension supports Gnome Shell DE, from version 3.4 up to 3.16

![Screenshot](https://github.com/eonpatapon/gnome-shell-extension-transmission-daemon/raw/master/screenshot.png)

![Add torrents](https://github.com/eonpatapon/gnome-shell-extension-transmission-daemon/raw/master/screenshot-add.png)

![Filter torrents by state](https://github.com/eonpatapon/gnome-shell-extension-transmission-daemon/raw/master/screenshot-filter.png)

## Installation

### Via extensions.gnome.org

https://extensions.gnome.org/extension/365/transmission-daemon-indicator/

### Manual installation

    git clone git://github.com/eonpatapon/gnome-shell-extension-transmission-daemon.git
    cd gnome-shell-extension-transmission-daemon
    # For gnome-shell < 3.10 use the gnome-shell-3.8 branch
    # For gnome-shell < 3.16 use the gnome-shell-3.14 branch
    cp -r transmission-daemon@patapon.info ~/.local/share/gnome-shell/extensions

Restart the shell and then enable the extension.

## Configuration

### With the transmission daemon

Enable the RPC interface in ``/etc/transmission-daemon/settings.json``.

See https://trac.transmissionbt.com/wiki/EditConfigFiles for complete documentation.

Set the host/port settings in the extension configuration.

### With the GTK transmission application

In the preferences enable the web client.
