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

const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Soup = imports.gi.Soup;
const Lang = imports.lang;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Util = imports.misc.util;
const Gtk = imports.gi.Gtk;
const ShellDBus = imports.ui.shellDBus;
const Shell = imports.gi.Shell;
const Gio = imports.gi.Gio;

const upArrow = decodeURIComponent(escape('↑')).toString()
const downArrow = decodeURIComponent(escape('↓')).toString()
const enabledIcon = "transmission";
const errorIcon = "dialog-warning";

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;

const TransmissionStatus = {
    STOPPED: 0,
    CHECK_WAIT: 1,
    CHECK: 2,
    DOWNLOAD_WAIT: 3,
    DOWNLOAD: 4,
    SEED_WAIT: 6,
    SEED: 6
}

const TDAEMON_SETTINGS_SCHEMA = 'org.gnome.shell.extensions.transmission-daemon';
const TDAEMON_HOST_KEY = 'host';
const TDAEMON_PORT_KEY = 'port';
const TDAEMON_USER_KEY = 'user';
const TDAEMON_PASSWORD_KEY = 'password';
const TDAEMON_RPC_URL_KEY = 'url';
const TDAEMON_STATS_NB_TORRENTS_KEY = 'stats-torrents';
const TDAEMON_STATS_ICONS_KEY = 'stats-icons';
const TDAEMON_STATS_NUMERIC_KEY = 'stats-numeric';
const TDAEMON_ALWAYS_SHOW_KEY = 'always-show';

if (!_httpSession) {
    const _httpSession = new Soup.SessionAsync();
    _httpSession.timeout = 10;
}

if (Soup.Session.prototype.add_feature != null)
        Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());

const TransmissionDaemonMonitor = new Lang.Class({
    Name: 'TransmissionDaemonMonitor',

    _init: function() {
        this._url = "";
        this._session_id = false;
        this._torrents = false;
        this._stats = false;
        this._timers = {};
        this._interval = 10;
        _httpSession.connect("authenticate", Lang.bind(this, this.authenticate));
        this.updateURL();
        this.retrieveInfos();
        gsettings.connect("changed", Lang.bind(this, function() {
            this.updateURL();
        }));
    },

    updateURL: function() {
        let host = gsettings.get_string(TDAEMON_HOST_KEY);
        let port = gsettings.get_int(TDAEMON_PORT_KEY);
        let rpc_url = gsettings.get_string(TDAEMON_RPC_URL_KEY);
        this._url = 'http://%s:%s%srpc/'.format(host, port.toString(), rpc_url);
    },

    authenticate: function(session, message, auth, retrying) {
        let user = gsettings.get_string(TDAEMON_USER_KEY);
        let password = gsettings.get_string(TDAEMON_PASSWORD_KEY);

        if (retrying) {
            transmissionDaemonIndicator.connectionError("Authentication failed");
            return;
        }

        if (user && password)
            auth.authenticate(user, password);
        else
            transmissionDaemonIndicator.connectionError("Missing user or password");
    },

    changeInterval: function(interval) {
        this._interval = interval;
        for (let source in this._timers)
            Mainloop.source_remove(this._timers[source]);
        this.retrieveInfos();
    },

    sendPost: function(data, callback) {
        let message = Soup.Message.new('POST', this._url);
        message.set_request("application/x-www-form-urlencoded",
                            Soup.MemoryUse.COPY,
                            JSON.stringify(data),
                            JSON.stringify(data).length);
        if (this._session_id)
            message.request_headers.append("X-Transmission-Session-Id",
                                                 this._session_id);
        _httpSession.queue_message(message, Lang.bind(this, callback));
    },

    retrieveInfos: function() {
        this.retrieveStats();
        this.retrieveList();
    },

    retrieveList: function() {
        let params = {
            method: "torrent-get",
            arguments: {
                fields: ["error", "errorString", "id", "isFinished",
                         "leftUntilDone", "name", "peersGettingFromUs",
                         "peersSendingToUs", "rateDownload", "rateUpload",
                         "percentDone", "isFinished", "peersConnected",
                         "uploadedEver", "sizeWhenDone", "status",
                         "uploadRatio"]
            }
        };
        this.sendPost(params, this.processList);
        if (this._timers.list)
            delete this._timers.list
    },

    retrieveStats: function() {
        let params = {
            method: "session-stats"
        };
        this.sendPost(params, this.processStats);
        if (this._timers.stats)
            delete this._timers.stats
    },

    start: function(torrent_id) {
        let params = {
            method: "torrent-start",
            arguments: {
                ids: torrent_id
            }
        };
        this.sendPost(params, this.onStart);
    },

    startAll: function() {
        let params = {
            method: "torrent-start"
        };
        this.sendPost(params, this.onStartAll);
    },

    stop: function(torrent_id) {
        let params = {
            method: "torrent-stop",
            arguments: {
                ids: torrent_id
            }
        };
        this.sendPost(params, this.onStop);
    },

    stopAll: function() {
        let params = {
            method: "torrent-stop"
        };
        this.sendPost(params, this.onStopAll);
    },

    remove: function(torrent_id) {
        let params = {
            method: "torrent-remove",
            arguments: {
                ids: [torrent_id]
            }
        };
        this.sendPost(params, this.onRemove);
    },

    processList: function(session, message) {
        if (message.status_code == "200") {
            //log(message.response_body.data);
            let response = JSON.parse(message.response_body.data);
            this._torrents = response.arguments.torrents;
            transmissionDaemonIndicator.updateList();
            if (!this._timers.list) {
                this._timers.list = Mainloop.timeout_add_seconds(
                                        this._interval,
                                        Lang.bind(this, this.retrieveList));
            }
        }
    },

    processStats: function(session, message) {
        if (message.status_code == "409") {
            this._session_id = message.response_headers.get_one('X-Transmission-Session-Id');
            this.retrieveInfos();
        }
        else {
            //log(message.status_code);
            //log(message.response_body.data);
            if (message.status_code == "200") {
                let response = JSON.parse(message.response_body.data);
                this._stats = response.arguments;
                transmissionDaemonIndicator.updateStats();
            }
            else {
                let error;
                switch(message.status_code) {
                    case 404:
                        error = "Can't access to %s".format(this._url);
                        break;
                    default:
                        error = "Can't connect to Transmission";
                        break;
                }
                if (error)
                    transmissionDaemonIndicator.connectionError(error);
            }
            if (!this._timers.stats) {
                this._timers.stats = Mainloop.timeout_add_seconds(
                                        this._interval,
                                        Lang.bind(this, this.retrieveStats));
            }
        }
    },

    onStart: function(session, message) {
        if (message.status_code != 200)
            log(message.response_body.data);
    },

    onStartAll: function(session, message) {
        if (message.status_code != 200)
            log(message.response_body.data);
    },

    onStop: function(session, message) {
        if (message.status_code != 200)
            log(message.response_body.data);
    },

    onStopAll: function(session, message) {
        if (message.status_code != 200)
            log(message.response_body.data);
    },

    onRemove: function(session, message) {
        if (message.status_code != 200)
            log(message.response_body.data);
    },

    getList: function() {
        return this._torrents;
    },

    getStats: function() {
        return this._stats;
    },

    getTorrentById: function(id) {
        for (let i in this._torrents) {
            if (this._torrents[i].id == id)
                return this._torrents[i];
        }
        return null;
    },

    destroy: function() {
        for (let source in this._timers)
            Mainloop.source_remove(this._timers[source]);
    }

});

const TransmissionDaemonIndicator = new Lang.Class({
    Name: 'TransmissionDaemonIndicator',
    Extends: PanelMenu.Button,

    _init: function() {
        this.parent(0.0, "transmission-daemon");

        this._torrents = {};
        this._monitor = transmissionDaemonMonitor;
        this._url = "";
        this._enabled = false;
        this._nb_torrents = 0;
        this._always_show = false;

        this._stop_btn = new Button('media-playback-pause', 'Pause all torrents',
                                    Lang.bind(this, this.stopAll));
        this._start_btn = new Button('media-playback-start', 'Start all torrents',
                                     Lang.bind(this, this.startAll));
        this._web_btn = new Button('web-browser', 'Open Web UI',
                                   Lang.bind(this, this.launchWebUI));
        this._pref_btn = new Button('preferences-system', 'Preferences',
                                    Lang.bind(this, this.launchPrefs));

        this._indicatorBox = new St.BoxLayout();
        this._icon = new St.Icon({icon_name: enabledIcon,
                                  style_class: 'system-status-icon'});
        this._status = new St.Label();

        this._indicatorBox.add(this._icon);
        this._indicatorBox.add(this._status);

        this.actor.add_actor(this._indicatorBox);
        this.actor.add_style_class_name('panel-status-button');

        this.setMenu(new TorrentsMenu(this.actor));

        this.updateOptions();
        gsettings.connect("changed", Lang.bind(this, function() {
            this.updateOptions();
            this.updateStats(true);
        }));

        this.refreshControls(false);
    },

    hide: function() {
        this.actor.hide();
    },

    show: function() {
        this.actor.show();
    },

    updateOptions: function() {
        this._status_show_torrents = gsettings.get_boolean(TDAEMON_STATS_NB_TORRENTS_KEY);
        this._status_show_icons = gsettings.get_boolean(TDAEMON_STATS_ICONS_KEY);
        this._status_show_numeric = gsettings.get_boolean(TDAEMON_STATS_NUMERIC_KEY);
        this._always_show = gsettings.get_boolean(TDAEMON_ALWAYS_SHOW_KEY);
        if (this._always_show)
            this.show();
        else if (!this._enabled)
            this.hide();
        let host = gsettings.get_string(TDAEMON_HOST_KEY);
        let port = gsettings.get_int(TDAEMON_PORT_KEY);
        let rpc_url = gsettings.get_string(TDAEMON_RPC_URL_KEY);
        this._url = 'http://%s:%s%sweb/'.format(host, port.toString(), rpc_url);
    },

    _onOpenStateChanged: function(menu, open) {
        this.parent(menu, open);
        if (open)
            this._monitor.changeInterval(2);
        else
            this._monitor.changeInterval(10);
    },

    connectionError: function(error) {
        if (!this._always_show)
            this.hide();
        this.removeTorrents();
        this._icon.icon_name = errorIcon;
        this._status.text = "";
        this.menu.controls.setInfo(error);
        this._enabled = false;
        this.refreshControls(true);
    },

    connectionAvailable: function() {
        if (!this._enabled) {
            this._icon.icon_name = enabledIcon;
            this._enabled = true;
            this.refreshControls(true);
            this.show();
        }
        this.refreshControls(false);
    },

    updateStats: function(dontChangeState) {
        let stats = this._monitor.getStats();
        let stats_text = "";
        let info_text = "";

        this._nb_torrents = stats.torrentCount;

        if (this._status_show_torrents && stats.torrentCount > 0)
            stats_text += stats.torrentCount;

        if (stats.downloadSpeed > 10000) {
            if (this._status_show_icons)
                stats_text += " %s".format(downArrow);
            if (this._status_show_numeric)
                stats_text += " %s/s".format(readableSize(stats.downloadSpeed));
        }
        if (stats.uploadSpeed > 2000) {
            if (this._status_show_icons)
                stats_text += " %s".format(upArrow);
            if (this._status_show_numeric)
                stats_text += " %s/s".format(readableSize(stats.uploadSpeed));
        }

        if (stats_text)
            stats_text = " " + stats_text;

        this._status.text = stats_text;

        if (this._nb_torrents > 0) {
            info_text = "%s %s/s / %s %s/s".format(
                                            downArrow,
                                            readableSize(stats.downloadSpeed),
                                            upArrow,
                                            readableSize(stats.uploadSpeed));
        }
        else {
            info_text = "No torrent";
        }

        this.menu.controls.setInfo(info_text);

        if (!dontChangeState)
            this.connectionAvailable();
    },

    refreshControls: function(state_changed) {
        if (state_changed)
            this.menu.controls.removeControls();

        if (this._enabled) {
            this.menu.controls.addControl(this._web_btn);
            if (this._nb_torrents > 0) {
                this.menu.controls.addControl(this._stop_btn);
                this.menu.controls.addControl(this._start_btn);
            }
            else {
                this.menu.controls.removeControl(this._stop_btn);
                this.menu.controls.removeControl(this._start_btn);
            }
        }
        else {
            this.menu.controls.addControl(this._pref_btn);
        }
    },

    stopAll: function() {
        this._monitor.stopAll();
    },

    startAll: function() {
        this._monitor.startAll();
    },

    launchWebUI: function() {
        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app(
            Gio.app_info_get_default_for_type('x-scheme-handler/http', false).get_id()
        );
        app.launch(global.display.get_current_time_roundtrip(),
                   [this._url], -1, null);
        this.menu.close();
    },

    launchPrefs: function() {
        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app('gnome-shell-extension-prefs.desktop');
        app.launch(global.display.get_current_time_roundtrip(),
                   ['extension:///transmission-daemon@patapon.info'], -1, null);
        this.menu.close();
    },

    updateList: function() {
        // Remove old torrents
        this.cleanTorrents();
        // Update all torrents properties
        this.updateTorrents();
    },

    cleanTorrents: function() {
        for (let id in this._torrents) {
            if (!this._monitor.getTorrentById(id))
                this.removeTorrent(id);
        }
    },

    removeTorrents: function() {
        for (let id in this._torrents)
            this.removeTorrent(id);
    },

    removeTorrent: function(id) {
        this._torrents[id].destroy();
        delete this._torrents[id];
    },

    updateTorrents: function() {
        let torrents = this._monitor.getList();
        for (let i in torrents)
            this.updateTorrent(torrents[i])
    },

    updateTorrent: function(torrent) {
        if (!this._torrents[torrent.id])
            this.addTorrent(torrent);
        else
            this._torrents[torrent.id].update(torrent);
    },

    addTorrent: function(torrent) {
        this._torrents[torrent.id] = new TransmissionTorrent(torrent);
        this.menu.addMenuItem(this._torrents[torrent.id]);
    },

    toString: function() {
        return "[object TransmissionDaemonIndicator]";
    }

});

const TransmissionTorrent = new Lang.Class({
    Name: 'TransmissionTorrent',
    Extends: PopupMenu.PopupMenuSection,

    _init: function(params) {
        this.parent();

        this._params = params;
        this._infos = {};
        this._error = false;
        this.buildInfo();

        this._name = new TorrentName(this._params);
        this._name.actor.remove_style_class_name('popup-menu-item');
        this.addMenuItem(this._name);

        this._seeds_info = new PopupMenu.PopupMenuItem(this._infos.seeds,
                                                       {reactive: false,
                                                        style_class: 'torrent-infos seeds-info'});
        this._seeds_info.actor.remove_style_class_name('popup-menu-item');
        this.addMenuItem(this._seeds_info);

        this._progress_bar = new St.DrawingArea({style_class: 'progress-bar',
                                                 reactive: false});
        this._progress_bar.height = 10;
        this._progress_bar.connect('repaint', Lang.bind(this, this._draw));
        this.addActor(this._progress_bar);

        this._size_info = new PopupMenu.PopupMenuItem(this._infos.size,
                                                      {reactive: false,
                                                       style_class: 'torrent-infos size-info'});
        this._size_info.actor.remove_style_class_name('popup-menu-item');
        this.addMenuItem(this._size_info);
    },

    buildInfo: function() {
        let rateDownload = readableSize(this._params.rateDownload);
        let rateUpload = readableSize(this._params.rateUpload);
        let currentSize = readableSize(this._params.sizeWhenDone * this._params.percentDone);
        let sizeWhenDone = readableSize(this._params.sizeWhenDone);
        let uploadedEver = readableSize(this._params.uploadedEver);
        let percentDone = (this._params.percentDone * 100).toFixed(1) + "%";
        this._params.percentUploaded = this._params.uploadedEver / this._params.sizeWhenDone;

        this._infos.seeds = "";
        this._infos.size = "";

        switch(this._params.status) {
            case TransmissionStatus.STOPPED:
            case TransmissionStatus.CHECK_WAIT:
            case TransmissionStatus.CHECK:
                if (this._params.isFinished) {
                    this._infos.seeds = "Seeding complete";
                    this._infos.size = "%s, uploaded %s (Ratio %s)".format(
                                                sizeWhenDone,
                                                uploadedEver,
                                                this._params.uploadRatio.toFixed(1));
                }
                else {
                    this._infos.seeds = "Paused";
                    this._infos.size = "%s of %s (%s)".format(currentSize,
                                                              sizeWhenDone,
                                                              percentDone);
                }
                break;
            case TransmissionStatus.DOWNLOAD_WAIT:
            case TransmissionStatus.DOWNLOAD:
                this._infos.seeds = "Downloading from %s of %s peers - %s %s/s %s %s/s".format(
                                            this._params.peersSendingToUs,
                                            this._params.peersConnected,
                                            downArrow,
                                            rateDownload,
                                            upArrow,
                                            rateUpload);
                this._infos.size = "%s of %s (%s)".format(currentSize,
                                                          sizeWhenDone,
                                                          percentDone);
                break;
            case TransmissionStatus.SEED_WAIT:
            case TransmissionStatus.SEED:
                this._infos.seeds = "Seeding to %s of %s peers - %s %s/s".format(
                                            this._params.peersGettingFromUs,
                                            this._params.peersConnected,
                                            upArrow,
                                            rateUpload);
                this._infos.size = "%s, uploaded %s (Ratio %s)".format(
                                            sizeWhenDone,
                                            uploadedEver,
                                            this._params.uploadRatio.toFixed(1));
                break;
        }

        if (this._params.error && this._params.errorString) {
            this._error = true;
            this._infos.seeds = this._params.errorString;
        }
        else
            this._error = false;

    },

    _draw: function() {
        let themeNode = this._progress_bar.get_theme_node();
        let barHeight = themeNode.get_length('-bar-height');
        let borderWidth = themeNode.get_length('-bar-border-width');
        let barColor = themeNode.get_color('-bar-color');
        let barBorderColor = themeNode.get_color('-bar-border-color');
        let uploadedColor = themeNode.get_color('-uploaded-color');
        let seedColor = themeNode.get_color('-seed-color');
        let seedBorderColor = themeNode.get_color('-seed-border-color');
        let downloadColor = themeNode.get_color('-download-color');
        let downloadBorderColor = themeNode.get_color('-download-border-color');
        let idleColor = themeNode.get_color('-idle-color');
        let idleBorderColor = themeNode.get_color('-idle-border-color');

        this._progress_bar.set_height(barHeight);
        let [width, height] = this._progress_bar.get_surface_size();
        let cr = this._progress_bar.get_context();

        let color = barColor;
        let border_color = barBorderColor
        // Background
        cr.rectangle(0, 0, width, height);
        Clutter.cairo_set_source_color(cr, color);
        cr.fillPreserve();
        cr.setLineWidth(borderWidth);
        Clutter.cairo_set_source_color(cr, border_color);
        cr.stroke();

        // Downloaded
        let show_upload = false;
        let widthDownloaded = Math.round(width * this._params.percentDone);

        switch(this._params.status) {
            case TransmissionStatus.STOPPED:
            case TransmissionStatus.CHECK_WAIT:
            case TransmissionStatus.CHECK:
                color = idleColor;
                border_color = idleBorderColor;
                break;
            case TransmissionStatus.DOWNLOAD_WAIT:
            case TransmissionStatus.DOWNLOAD:
                color = downloadColor;
                border_color = downloadBorderColor;
                break;
            case TransmissionStatus.SEED_WAIT:
            case TransmissionStatus.SEED:
                color = seedColor;
                border_color = seedBorderColor;
                show_upload = true;
                break;
        }
        Clutter.cairo_set_source_color(cr, color);
        cr.rectangle(0, 0, widthDownloaded, height);
        Clutter.cairo_set_source_color(cr, color);
        cr.fillPreserve();
        cr.setLineWidth(borderWidth);
        Clutter.cairo_set_source_color(cr, border_color);
        cr.stroke();

        // Uploaded
        if (show_upload) {
            let ratio = this._params.uploadRatio;
            if (ratio > 1)
                ratio = 1;
            let widthUploaded = Math.round(width * ratio);
            color = uploadedColor;
            border_color = seedBorderColor;
            Clutter.cairo_set_source_color(cr, color);
            cr.rectangle(0, 0, widthUploaded, height);
            Clutter.cairo_set_source_color(cr, color);
            cr.fillPreserve();
            cr.setLineWidth(borderWidth);
            Clutter.cairo_set_source_color(cr, border_color);
            cr.stroke();
        }
    },

    update: function(params) {
        this._params = params;
        this.buildInfo();
        this._seeds_info.label.text = this._infos.seeds;
        if (this._error)
            this._seeds_info.label.add_style_class_name("error");
        else
            this._seeds_info.label.remove_style_class_name("error");
        this._size_info.label.text = this._infos.size;
        this._progress_bar.queue_repaint();
        this._name.update(this._params);
    },

    toString: function() {
        return "[object TransmissionTorrent <%s>]".format(this._params.name);
    },
});

const TorrentName = new Lang.Class({
    Name: 'TorrentName',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function (params) {
        this.parent({reactive: false,
                     style_class: 'torrent-name'});

        this.id = params.id;
        this.status = params.status;

        this.box = new St.BoxLayout({vertical: false});

        let name_label = new St.Label({text: params.name});

        this.addActor(name_label);
        this.addActor(this.box, {span: -1, align: St.Align.END});

        this.updateButtons();
    },

    start: function () {
        transmissionDaemonMonitor.start(this.id);
    },

    stop: function () {
        transmissionDaemonMonitor.stop(this.id);
    },

    remove: function () {
        transmissionDaemonMonitor.remove(this.id);
    },

    update: function (params) {
        this.status = params.status;
        this.updateButtons();
    },

    updateButtons: function () {
        this.box.destroy_all_children();
        let start_stop_btn;
        switch(this.status) {
            case TransmissionStatus.STOPPED:
            case TransmissionStatus.CHECK_WAIT:
            case TransmissionStatus.CHECK:
                start_stop_btn = new Button("media-playback-start", null,
                                            Lang.bind(this, this.start), "small");
                break;
            default:
                start_stop_btn = new Button("media-playback-pause", null,
                                            Lang.bind(this, this.stop), "small");
                break;
        }
        let remove_btn = new Button("user-trash", null,
                                    Lang.bind(this, this.remove), "small");

        this.box.add(start_stop_btn);
        this.box.add(remove_btn);
    },
});

const TorrentsControls = new Lang.Class({
    Name: 'TorrentsControls',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function () {
        this.parent({reactive: false});

        this.box = new St.BoxLayout({vertical: false,
                                     style_class: 'torrents-controls'});
        this.info = new St.Label({text: "Connecting..."});
        this._old_info = "";
        this.hover = false;

        this.addActor(this.box);
        this.addActor(this.info, {span: -1, align: St.Align.END});
    },

    setInfo: function(text) {
        if (!this.hover)
            this.info.text = text;
    },

    addControl: function(button, name) {
        if (!this.box.contains(button)) {
            this.box.add_actor(button);
            button.connect('notify::hover', Lang.bind(this, function(button) {
                this.hover = button.hover;
                if (this.hover) {
                    if (button._info != this.info.text)
                        this._old_info = this.info.text;
                    this.info.text = button._info;
                }
                else
                    this.info.text = this._old_info;
            }));
        }
    },

    removeControl: function(button, name) {
        if (this.box.contains(button))
            this.box.remove_actor(button);
    },

    removeControls: function() {
        this.box.get_children().forEach(Lang.bind(this, function(b) {
            this.removeControl(b);
        }));
    }
});

const Button = new Lang.Class({
    Name: 'Button',
    Extends: St.Bin,

    _init: function(icon, info, callback, type) {

        let style= 'torrents-control';
        let icon_size = 20;
        let padding = 8;

        if (type && type == "small") {
            style= 'torrent-control';
            icon_size = 16;
            padding = 3;
        }

        this.parent({reactive: true, can_focus: true, style_class: style,
                     track_hover: true});

        this.icon = new St.Icon({
            icon_type: St.IconType.SYMBOLIC,
            icon_name: icon,
            icon_size: icon_size,
        });
        this.button = new St.Button({style_class: 'notification-icon-button',
                                     child: this.icon});
        this.button.connect('clicked', callback);

        this.add_actor(this.button);

        // override base style
        this.icon.set_style('padding: 0px');
        this.button.set_style('padding: %spx'.format(padding.toString()));

        this._info = info;
    },

    setIcon: function(icon) {
        this.icon.icon_name = icon;
    }
});

const TorrentsMenu = new Lang.Class({
    Name: 'TorrentsMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(sourceActor) {
        this.parent(sourceActor, 0.0, St.Side.TOP);

        // override base style
        this._boxWrapper.set_style('min-width: 400px');

        this.controls = new TorrentsControls();

        this._scroll = new St.ScrollView({style_class: 'vfade popup-sub-menu torrents-list',
                                          hscrollbar_policy: Gtk.PolicyType.NEVER,
                                          vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        this._scrollBox = new St.BoxLayout({vertical: true});
        this._scroll.add_actor(this._scrollBox);

        this.addMenuItem(this.controls);
        this.box.add(this._scroll);

        let vscroll = this._scroll.get_vscroll_bar();
        vscroll.connect('scroll-start', Lang.bind(this, function() {
                                            this.passEvents = true;
                                        }));
        vscroll.connect('scroll-stop', Lang.bind(this, function() {
                                            this.passEvents = false;
                                        }));
    },

    addMenuItem: function(menuItem, position) {
        if (menuItem instanceof TransmissionTorrent) {
            this._scrollBox.add(menuItem.actor);
            this._connectSubMenuSignals(menuItem, menuItem);
            menuItem._closingId = this.connect('open-state-changed',
                function(self, open) {
                    if (!open)
                        menuItem.close(false);
                });
            menuItem.connect('destroy', Lang.bind(this, function() {
                menuItem.disconnect(menuItem._subMenuActivateId);
                menuItem.disconnect(menuItem._subMenuActiveChangeId);

                this.length--;
            }));
        }
        else {
            this.parent(menuItem, position);
        }
    }
});

let gsettings;
let transmissionDaemonMonitor;
let transmissionDaemonIndicator;

function init(extensionMeta) {
    gsettings = Lib.getSettings(Me);
    let theme = imports.gi.Gtk.IconTheme.get_default();
    theme.append_search_path(extensionMeta.path + "/icons");
}

function enable() {
    transmissionDaemonMonitor = new TransmissionDaemonMonitor();
    transmissionDaemonIndicator = new TransmissionDaemonIndicator();
    Main.panel.addToStatusArea('transmission-daemon', transmissionDaemonIndicator);
}

function disable() {
    transmissionDaemonMonitor.destroy();
    transmissionDaemonMonitor = null;
    transmissionDaemonIndicator.destroy();
    transmissionDaemonIndicator = null;
}

function readableSize(size) {
    if (!size)
        size = 0;
    let units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    let i = 0;
    while (size >= 1000) {
        size /= 1000;
        ++i;
    }
    let n = i;
    if (n > 0 && size > 0)
        n--;

    return "%s %s".format(size.toFixed(n), units[i]);
}
