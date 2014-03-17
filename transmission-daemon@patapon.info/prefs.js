/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
/**
    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
**/

const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;

const Gettext = imports.gettext.domain('gnome-shell-extension-transmission-daemon');
const _ = Gettext.gettext;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;

let gsettings;
let settings;

function init() {
    Lib.initTranslations(Me);
    gsettings = Lib.getSettings(Me);
    settings = {
        host: {label: _("Hostname"), help: _('Hostname or IP where Transmission is running'), type: 's'},
        port: {label: _("Port"), help: _('Default is 9091'), type: 'i'},
        ssl: {label: _("Use SSL ?"), type: 'b'},
        user: {label: _("Username"), help: _('Username to authenticate to Transmission (optional)'), type: 's'},
        password: {label: _("Password"), help: _('Password to authenticate to Transmission (optional)'), type: 's', mode: 'passwd'},
        always_show: {label: _('Always show the indicator'), help: _('Show the indicator even if Transmission is not running'), type: 'b'},
        stats_torrents: {label: _('Show the number of torrents in the status bar'), type: 'b'},
        stats_icons: {label: _('Show upload and download icons in the status bar'), type: 'b'},
        stats_numeric: {label: _('Show upload and download speed in the status bar'), type: 'b'}
    }
}

function buildPrefsWidget() {
    let frame = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                             border_width: 10 });
    let vbox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                            margin: 20, margin_top: 10 });
    let hbox;

    for (setting in settings) {
        if (settings[setting].type == 's')
            hbox = createStringSetting(setting);
        if (settings[setting].type == "i")
            hbox = createIntSetting(setting);
        if (settings[setting].type == "b")
            hbox = createBoolSetting(setting);
        vbox.add(hbox);
    }

    frame.add(vbox);
    frame.show_all();
    return frame;
}

function createStringSetting(setting) {

    let hbox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                            margin_top: 5});

    let setting_label = new Gtk.Label({label: settings[setting].label,
                                       xalign: 0 });

    let setting_string = new Gtk.Entry({text: gsettings.get_string(setting.replace('_', '-'))});
    setting_string.connect('notify::text', function(entry) {
        gsettings.set_string(setting.replace('_', '-'), entry.text);
    });

    if (settings[setting].mode == "passwd") {
        setting_string.set_visibility(false);
    }

    if (settings[setting].help) {
        setting_label.set_tooltip_text(settings[setting].help)
        setting_string.set_tooltip_text(settings[setting].help)
    }

    hbox.pack_start(setting_label, true, true, 0);
    hbox.add(setting_string);

    return hbox;
}

function createIntSetting(setting) {

    let hbox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                            margin_top: 5});

    let setting_label = new Gtk.Label({label: settings[setting].label,
                                       xalign: 0 });

    let adjustment = new Gtk.Adjustment({ lower: 1, upper: 65535, step_increment: 1});
    let setting_int = new Gtk.SpinButton({adjustment: adjustment,
                                          snap_to_ticks: true});
    setting_int.set_value(gsettings.get_int(setting.replace('_', '-')));
    setting_int.connect('value-changed', function(entry) {
        gsettings.set_int(setting.replace('_', '-'), entry.value);
    });

    if (settings[setting].help) {
        setting_label.set_tooltip_text(settings[setting].help)
        setting_int.set_tooltip_text(settings[setting].help)
    }

    hbox.pack_start(setting_label, true, true, 0);
    hbox.add(setting_int);

    return hbox;
}

function createBoolSetting(setting) {

    let hbox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                            margin_top: 5});

    let setting_label = new Gtk.Label({label: settings[setting].label,
                                       xalign: 0 });

    let setting_switch = new Gtk.Switch({active: gsettings.get_boolean(setting.replace('_', '-'))});
    setting_switch.connect('notify::active', function(button) {
        gsettings.set_boolean(setting.replace('_', '-'), button.active);
    });

    if (settings[setting].help) {
        setting_label.set_tooltip_text(settings[setting].help)
        setting_switch.set_tooltip_text(settings[setting].help)
    }

    hbox.pack_start(setting_label, true, true, 0);
    hbox.add(setting_switch);

    return hbox;
}
