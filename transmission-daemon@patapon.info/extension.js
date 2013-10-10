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

let upArrow = "";
let downArrow = "";
try {
    upArrow = decodeURIComponent(escape('↑')).toString();
    downArrow = decodeURIComponent(escape('↓')).toString();
}
catch(e) {
    upArrow = '↑';
    downArrow = '↓';
}

const enabledIcon = "my-transmission-symbolic";
const errorIcon = "my-transmission-error-symbolic";
const connectIcon = "my-transmission-connecting-symbolic";

const ExtensionUtils = imports.misc.extensionUtils;

const Gettext = imports.gettext.domain('gnome-shell-extension-transmission-daemon');
const _ = Gettext.gettext;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;

let TransmissionStatus = {
    STOPPED: 0,
    CHECK_WAIT: 1,
    CHECK: 2,
    DOWNLOAD_WAIT: 3,
    DOWNLOAD: 4,
    SEED_WAIT: 5,
    SEED: 6
}

const TransmissionError = {
    NONE: 0,
    TRACKER_WARNING: 1,
    TRACKER_ERROR: 2,
    LOCAL_ERROR: 3
}

const ErrorType = {
    NO_ERROR: 0,
    CONNECTION_ERROR: 1,
    AUTHENTICATION_ERROR: 2,
    CONNECTING: 3
}

const StatusFilter = {
    ALL: 0,
    ACTIVE: 1,
    DOWNLOADING: 2,
    SEEDING: 3,
    PAUSED: 4,
    FINISHED: 5
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
const TDAEMON_LATEST_FILTER = 'latest-filter';
const TDAEMON_TORRENTS_DISPLAY = 'torrents-display';

const TorrentDisplayClass = {
    TransmissionTorrent: 0,
    TransmissionTorrentSmall: 1
}

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
        this._session = false;
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
        if (port == 443)
            this._url = 'https://%s%srpc'.format(host, rpc_url);
        else
            this._url = 'http://%s:%s%srpc'.format(host, port.toString(), rpc_url);
    },

    authenticate: function(session, message, auth, retrying) {
        let user = gsettings.get_string(TDAEMON_USER_KEY);
        let password = gsettings.get_string(TDAEMON_PASSWORD_KEY);

        if (retrying) {
            transmissionDaemonIndicator.connectionError(ErrorType.AUTHENTICATION_ERROR,
                                                        _("Authentication failed"));
            return;
        }

        if (user && password)
            auth.authenticate(user, password);
        else
            transmissionDaemonIndicator.connectionError(ErrorType.AUTHENTICATION_ERROR,
                                                        _("Missing username or password"));
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
        this.retrieveSession();
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
                         "webseedsSendingToUs", "uploadRatio", "eta"]
            }
        };
        if (this._torrents != false)
            params.arguments.ids = "recently-active";
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

    retrieveSession: function() {
        let params = {
            method: "session-get"
        };
        this.sendPost(params, this.processSession);
        if (this._timers.session)
            delete this._timers.session
    },

    torrentAction: function(action, torrent_id) {
        let params = {
            method: "torrent-%s".format(action),
        };
        if (torrent_id) {
            params.arguments = {
                ids: [torrent_id]
            };
        }
        this.sendPost(params, this.onTorrentAction);
    },

    torrentAdd: function(url) {
        let params = {
            method: "torrent-add",
            arguments: {
                filename: url
            }
        };
        this.sendPost(params, this.onTorrentAdd);
    },

    setAltSpeed: function(enable) {
        let params = {
            method: "session-set",
            arguments: {
                'alt-speed-enabled': enable
            }
        };
        this.sendPost(params, this.onSessionAction);
    },

    processList: function(session, message) {
        if (message.status_code == "200") {
            //log(message.response_body.data);
            let response = JSON.parse(message.response_body.data);
            this._torrents = response.arguments.torrents;
            let to_remove = response.arguments.removed;
            transmissionDaemonIndicator.updateList(to_remove);
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
                        error = _("Can't access to %s").format(this._url);
                        break;
                    case 401:
                        // See this.authenticate
                        break;
                    default:
                        error = _("Can't connect to Transmission");
                        break;
                }
                if (error)
                    transmissionDaemonIndicator.connectionError(ErrorType.CONNECTION_ERROR,
                                                                error);
                // clean torrent list on connection error
                this.torrents = false;
            }
            if (!this._timers.stats) {
                this._timers.stats = Mainloop.timeout_add_seconds(
                                        this._interval,
                                        Lang.bind(this, this.retrieveStats));
            }
        }
    },

    processSession: function(session, message) {
        if (message.status_code == "200") {
            //log(message.response_body.data);
            let response = JSON.parse(message.response_body.data);
            this._session = response.arguments;

            transmissionDaemonIndicator.toggleTurtleMode(this._session['alt-speed-enabled']);

            // compat with older daemons
            if (this._session['rpc-version'] < 14) {
                TransmissionStatus = {
                    CHECK_WAIT: 1,
                    CHECK: 2,
                    DOWNLOAD: 4,
                    SEED: 8,
                    STOPPED: 16
                }
            }

            if (!this._timers.session) {
                this._timers.session = Mainloop.timeout_add_seconds(
                                        this._interval * 1.8,
                                        Lang.bind(this, this.retrieveSession));
            }
        }
    },

    onSessionAction: function(session, message) {
        if (message.status_code != 200)
            log(message.response_body.data);
    },

    onTorrentAction: function(session, message) {
        if (message.status_code != 200)
            log(message.response_body.data);
    },

    onTorrentAdd: function(session, message) {
        let result = JSON.parse(message.response_body.data);
        let added = false;
        if (result.arguments['torrent-added'])
            added = true;
        transmissionDaemonIndicator.torrentAdded(added);
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
        this._host = "";
        this._url = "";
        this._server_type = "daemon";
        this._state = ErrorType.CONNECTING;
        this._nb_torrents = 0;
        this._always_show = false;

        this._stop_btn = new ControlButton('media-playback-pause',
                                           _('Pause all torrents'),
                                           Lang.bind(this, this.stopAll));
        this._start_btn = new ControlButton('media-playback-start',
                                            _('Start all torrents'),
                                            Lang.bind(this, this.startAll));
        this._web_btn = new ControlButton('web-browser', _('Open Web UI'),
                                          Lang.bind(this, this.launchWebUI));
        this._client_btn = new ControlButton('my-transmission', _('Open Transmission'),
                                             Lang.bind(this, this.launchClient));
        this._pref_btn = new ControlButton('preferences-system',
                                           _('Preferences'),
                                           Lang.bind(this, this.launchPrefs));
        this._add_btn = new ControlButton('list-add',
                                           _('Add torrent'),
                                           Lang.bind(this, this.toggleAddEntry));
        this._turtle_btn = new ControlButton('turtle',
                                             _('Toggle turtle mode'),
                                             Lang.bind(this, this.toggleTurtleMode));
        this._display_btn = new ControlButton('view-list',
                                              _('Toggle display mode'),
                                              Lang.bind(this, this.toggleDisplayMode));

        this._indicatorBox = new St.BoxLayout();
        this._icon = new St.Icon({icon_name: connectIcon,
                                  style_class: 'system-status-icon'});
        this._status = new St.Label({text: ''});

        this._indicatorBox.add(this._icon);
        this._indicatorBox.add(this._status);

        this.actor.add_actor(this._indicatorBox);
        this.actor.add_style_class_name('panel-status-button');

        let menu = new TorrentsMenu(this.actor)
        menu._delegate = this;
        this.setMenu(menu);

        this.updateOptions();
        gsettings.connect("changed", Lang.bind(this, function() {
            this.updateOptions();
            this.updateStats(true);
        }));

        this.refreshControls(false);

        if (gsettings.get_enum(TDAEMON_TORRENTS_DISPLAY) == TorrentDisplayClass.TransmissionTorrentSmall) {
            this.toggleDisplayMode(true);
        }
    },

    hide: function() {
        if (!this._always_show)
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
        else if (this._state == ErrorType.CONNECTION_ERROR)
            this.hide();
        this._host = gsettings.get_string(TDAEMON_HOST_KEY);
        let port = gsettings.get_int(TDAEMON_PORT_KEY);
        let rpc_url = gsettings.get_string(TDAEMON_RPC_URL_KEY);
        if (port == 443)
            this._url = 'https://%s%sweb/'.format(this._host, rpc_url);
        else
            this._url = 'http://%s:%s%sweb/'.format(this._host, port.toString(), rpc_url);
    },

    _onOpenStateChanged: function(menu, open) {
        this.parent(menu, open);
        if (open)
            this._monitor.changeInterval(2);
        else
            this._monitor.changeInterval(10);
    },

    torrentAdded: function(added) {
        this.menu.controls.torrentAdded(added);
    },

    connectionError: function(type, error) {
        if (type == ErrorType.CONNECTION_ERROR)
            this.hide();
        else
            this.show();
        this._state = type;
        this.removeTorrents();
        this._icon.icon_name = errorIcon;
        this._status.text = "";
        this.menu.controls.setInfo(error);
        this.refreshControls(true);
    },

    connectionAvailable: function() {
        if (this._state != ErrorType.NO_ERROR) {
            this._icon.icon_name = enabledIcon;
            this._state = ErrorType.NO_ERROR;
            this.checkServer();
            this.show();
        }
        else
            this.refreshControls(false);
    },

    checkServer: function() {
        const DBusIface = <interface name="org.freedesktop.DBus">
        <method name="ListNames">
            <arg type="as" direction="out" />
        </method>
        </interface>;
        const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);
        let proxy = new DBusProxy(Gio.DBus.session, 'org.freedesktop.DBus',
                                  '/org/freedesktop/DBus');
        proxy.ListNamesRemote(Lang.bind(this, function(names) {
            this._server_type = "daemon";
            for (n in names[0]) {
                let name = names[0][n];
                if (name.search('com.transmissionbt.transmission') > -1
                   && (this._host == "localhost" || this._host == "127.0.0.1")) {
                    this._server_type = "client";
                    break;
                }
            }
            this.refreshControls(true);
        }));

    },

    updateStats: function(dontChangeState) {
        let stats = this._monitor.getStats();
        let stats_text = "";
        let info_text = "";

        this._nb_torrents = stats.torrentCount;

        if (this._status_show_torrents && stats.torrentCount > 0)
            stats_text += stats.torrentCount;

        if (stats.downloadSpeed > 10000) {
            if (stats_text && this._status_show_icons)
                stats_text += " ";
            if (this._status_show_icons)
                stats_text += downArrow;
            if (this._status_show_numeric)
                stats_text += " %s/s".format(readableSize(stats.downloadSpeed));
        }
        if (stats.uploadSpeed > 2000) {
            if (this._status_show_icons && this._status_show_numeric)
                stats_text += " ";
            if (this._status_show_icons)
                stats_text += upArrow;
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
            info_text = _("No torrent");
        }

        this.menu.controls.setInfo(info_text);

        if (!dontChangeState)
            this.connectionAvailable();
    },

    refreshControls: function(state_changed) {
        if (state_changed) {
            this.menu.controls.removeControls();
            this.menu.bottom_controls.removeControls();
            this.menu.filters.hide();
        }

        if (this._state == ErrorType.NO_ERROR) {
            if (this._server_type == "daemon")
                this.menu.controls.addControl(this._web_btn, 0);
            else
                this.menu.controls.addControl(this._client_btn, 0);
            this.menu.controls.addControl(this._add_btn);
            if (this._nb_torrents > 0) {
                this.menu.controls.addControl(this._stop_btn);
                this.menu.controls.addControl(this._start_btn);
                this.menu.filters.show();
            }
            else {
                this.menu.controls.removeControl(this._stop_btn);
                this.menu.controls.removeControl(this._start_btn);
                this.menu.filters.hide();
            }
            this.menu.bottom_controls.addControl(this._turtle_btn);
            this.menu.bottom_controls.addControl(this._display_btn);
        }
        else {
            this.menu.controls.addControl(this._pref_btn);
        }
    },

    stopAll: function() {
        this._monitor.torrentAction("stop");
    },

    startAll: function() {
        this._monitor.torrentAction("start");
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

    launchClient: function() {
        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app('transmission-gtk.desktop');
        let appWin = this.findAppWindow(app);
        let workspace_index = global.screen.get_active_workspace_index();
        let workspace = global.screen.get_active_workspace();

        // Window is on the current workspace
        if (app.is_on_workspace(workspace)) {
            // If the window is currently focused
            // minimize it and close the menu
            if (appWin && global.display.focus_window == appWin) {
                appWin.minimize();
                this.menu.close();
            }
            // Bring the window to front
            else
                app.activate_full(-1, 0);
        }
        else {
            // Change to the current workspace and
            // bring to front
            if (appWin)
                appWin.change_workspace_by_index(workspace_index, false,
                                                 global.get_current_time());
            app.activate_full(-1, 0);
        }
    },

    findAppWindow: function(app) {
        let tracker = Shell.WindowTracker.get_default();
        let windowActors = global.get_window_actors();
        for (let i in windowActors) {
            let win = windowActors[i].get_meta_window();
            if (tracker.get_window_app(win) == app)
                return win;
        }
        return false;
    },

    launchPrefs: function() {
        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app('gnome-shell-extension-prefs.desktop');
        app.launch(global.display.get_current_time_roundtrip(),
                   ['extension:///transmission-daemon@patapon.info'], -1, null);
        this.menu.close();
    },

    toggleAddEntry: function() {
        this.menu.controls.toggleAddEntry(this._add_btn);
    },

    toggleTurtleMode: function(state) {
        this.menu.bottom_controls.toggleTurtleMode(this._turtle_btn, state);
    },

    toggleDisplayMode: function(state) {
        this.menu.bottom_controls.toggleDisplayMode(this._display_btn, state);
    },

    updateList: function(to_remove) {
        // Remove old torrents
        this.cleanTorrents(to_remove);
        // Update all torrents properties
        this.updateTorrents();
        // Filter torrents
        this.menu.filters.filterByState();
    },

    cleanTorrents: function(to_remove) {
        for (let id in to_remove)
            this.removeTorrent(to_remove[id]);
    },

    removeTorrents: function() {
        for (let id in this._torrents)
            this.removeTorrent(id);
    },

    removeTorrent: function(id) {
        if (this._torrents[id]) {
            this._torrents[id].destroy();
            delete this._torrents[id];
        }
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

    addTorrent: function(torrent, visible) {
        let klass = TorrentDisplayClasses[gsettings.get_enum(TDAEMON_TORRENTS_DISPLAY)]
        this._torrents[torrent.id] = new klass(torrent);
        if (visible === false)
            this._torrents[torrent.id].hide();
        this.menu.addMenuItem(this._torrents[torrent.id]);
    },

    changeTorrentClass: function() {
        for (let id in this._torrents) {
            let visible = this._torrents[id].actor.visible;
            let torrent = this._torrents[id]._params;
            this.removeTorrent(id);
            this.addTorrent(torrent, visible);
        }
    },

    toString: function() {
        return "[object TransmissionDaemonIndicator]";
    }

});

const TransmissionTorrentSmall = new Lang.Class({
    Name: 'TransmissionTorrentSmall',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function(params) {
        this.parent({reactive: false,
                     style_class: 'torrent-small'});

        this._params = params;
        this._info = "";

        this.box = new St.BoxLayout({vertical: false, style_class: 'torrent-small-infos'});

        let name_label = new St.Label({text: this._params.name});
        name_label.set_style('max-width: 300px');

        this.infos = new St.Label({text: ''});
        this.box.add(this.infos);

        this.addActor(name_label);
        this.addActor(this.box, {span: -1, align: St.Align.END});

        this.buildInfo();
    },

    buildInfo: function() {
        let infos = new Array();
        let rateDownload = readableSize(this._params.rateDownload);
        let rateUpload = readableSize(this._params.rateUpload);
        let ratio = this._params.uploadRatio.toFixed(1);
        let percentDone = (this._params.percentDone * 100).toFixed(1) + "%";

        if (ratio > 0)
            infos.push('<span foreground="#aaa" size="xx-small">' + _('Ratio %s').format(ratio) + '</span>');
        if (this._params.rateDownload > 0)
            infos.push('<span foreground="#97EE4D"><b>%s</b> %s/s</span>'.format(downArrow,
                                                                                 rateDownload));
        if (this._params.rateUpload > 0)
            infos.push('<span foreground="#4DBFEE">%s %s/s</span>'.format(upArrow,
                                                                          rateUpload));
        infos.push('<span foreground="#ccc" size="xx-small">%s</span>'.format(percentDone));

        this._info = infos.join('<span foreground="#aaa">,</span> ');
        this.infos.clutter_text.set_markup(this._info);
    },

    update: function(params) {
        this._params = params;
        this.buildInfo();
    },

    toString: function() {
        return "[object TransmissionTorrentSmall <%s>]".format(this._params.name);
    },

    close: function() {},

    hide: function() {
        this.actor.hide();
    },

    show: function() {
        this.actor.show();
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

        this._error_info = new PopupMenu.PopupMenuItem(this._infos.error,
                                                       {reactive: false,
                                                        style_class: 'torrent-infos error'});
        this._error_info.actor.remove_style_class_name('popup-menu-item');
        this.addMenuItem(this._error_info);
        this._error_info.actor.hide();

        this._size_info = new PopupMenu.PopupMenuItem(this._infos.size,
                                                      {reactive: false,
                                                       style_class: 'torrent-infos size-info'});
        this._size_info.actor.remove_style_class_name('popup-menu-item');
        this.addMenuItem(this._size_info);

    },

    getStateString: function(state) {
        switch(state) {
            case TransmissionStatus.STOPPED:
                if (this._params.isFinished)
                    return _("Seeding complete");
                else
                    return _("Paused");
            case TransmissionStatus.CHECK_WAIT:
                return _("Queued for verification");
            case TransmissionStatus.CHECK:
                return _("Verifying local data");
            case TransmissionStatus.DOWNLOAD_WAIT:
                return _("Queued for download");
            case TransmissionStatus.DOWNLOAD:
                return _("Downloading");
            case TransmissionStatus.SEED_WAIT:
                return _("Queued for seeding");
            case TransmissionStatus.SEED:
                return _("Seeding");
        }

        return false;
    },

    buildInfo: function() {
        let rateDownload = readableSize(this._params.rateDownload);
        let rateUpload = readableSize(this._params.rateUpload);
        let currentSize = readableSize(this._params.sizeWhenDone * this._params.percentDone);
        let sizeWhenDone = readableSize(this._params.sizeWhenDone);
        let uploadedEver = readableSize(this._params.uploadedEver);
        let percentDone = (this._params.percentDone * 100).toFixed(1) + "%";
        let eta = this._params.eta;
        this._params.percentUploaded = this._params.uploadedEver / this._params.sizeWhenDone;

        this._infos.seeds = "";
        this._infos.size = "";
        this._infos.error = "";

        switch(this._params.status) {
            case TransmissionStatus.STOPPED:
            case TransmissionStatus.CHECK_WAIT:
            case TransmissionStatus.CHECK:
                this._infos.seeds = this.getStateString(this._params.status);
                if (this._params.isFinished) {
                    this._infos.size = _("%s, uploaded %s (Ratio %s)").format(
                                                sizeWhenDone,
                                                uploadedEver,
                                                this._params.uploadRatio.toFixed(1));
                }
                else {
                    this._infos.size = _("%s of %s (%s)").format(currentSize,
                                                                 sizeWhenDone,
                                                                 percentDone);
                }
                break;
            case TransmissionStatus.DOWNLOAD_WAIT:
            case TransmissionStatus.DOWNLOAD:
                if (this._params.status == TransmissionStatus.DOWNLOAD)
                    this._infos.seeds = _("Downloading from %s of %s peers - %s %s/s %s %s/s").format(
                                                this._params.peersSendingToUs,
                                                this._params.peersConnected,
                                                downArrow,
                                                rateDownload,
                                                upArrow,
                                                rateUpload);
                else
                    this._infos.seeds = this.getStateString(TransmissionStatus.DOWNLOAD_WAIT)

                // Format ETA string
                if (eta < 0 || eta >= (999*60*60))
                    eta = _('remaining time unknown');
                else
                    eta = _('%s remaining').format(timeInterval(eta));

                this._infos.size = _("%s of %s (%s) - %s").format(currentSize,
                                                             sizeWhenDone,
                                                             percentDone,
                                                             eta);
                break;
            case TransmissionStatus.SEED_WAIT:
            case TransmissionStatus.SEED:
                if (this._params.status == TransmissionStatus.SEED)
                    this._infos.seeds = _("Seeding to %s of %s peers - %s %s/s").format(
                                                this._params.peersGettingFromUs,
                                                this._params.peersConnected,
                                                upArrow,
                                                rateUpload);
                else
                    this._infos.seeds = this.getStateString(TransmissionStatus.SEED_WAIT);

                this._infos.size = _("%s, uploaded %s (Ratio %s)").format(
                                            sizeWhenDone,
                                            uploadedEver,
                                            this._params.uploadRatio.toFixed(1));
                break;
        }

        if (this._params.error && this._params.errorString) {
            switch(this._params.error) {
                case TransmissionError.TRACKER_WARNING:
                    this._infos.error = _("Tracker returned a warning: %s").format(this._params.errorString);
                    break;
                case TransmissionError.TRACKER_ERROR:
                    this._infos.error = _("Tracker returned an error: %s").format(this._params.errorString);
                    break;
                case TransmissionError.LOCAL_ERROR:
                    this._infos.error = _("Error: %s").format(this._params.errorString);
                    break;
            }
            this._error = true;
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
        if (this._error) {
            this._error_info.label.text = this._infos.error;
            this._error_info.actor.show();
        }
        else
            this._error_info.actor.hide();
        this._size_info.label.text = this._infos.size;
        this._progress_bar.queue_repaint();
        this._name.update(this._params);
    },

    toString: function() {
        return "[object TransmissionTorrent <%s>]".format(this._params.name);
    },

    hide: function() {
        this.actor.hide();
    },

    show: function() {
        this.actor.show();
    },

    destroy: function() {
        this._name.destroy();
        this._seeds_info.destroy();
        this._progress_bar.destroy();
        this._error_info.destroy();
        this._size_info.destroy();
        this.parent();
    }
});

const TorrentName = new Lang.Class({
    Name: 'TorrentName',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function (params) {
        this.parent({reactive: false,
                     style_class: 'torrent-name'});

        this.id = params.id;
        this.status = params.status;

        this.box = new St.BoxLayout({vertical: false,
                                     style_class: 'torrent-controls'});

        let name_label = new St.Label({text: params.name});
        name_label.set_style('max-width: 350px');

        this.addActor(name_label);
        this.addActor(this.box, {span: -1, align: St.Align.END});

        this.updateButtons();
    },

    start: function () {
        transmissionDaemonMonitor.torrentAction("start", this.id);
    },

    stop: function () {
        transmissionDaemonMonitor.torrentAction("stop", this.id);
    },

    remove: function () {
        transmissionDaemonMonitor.torrentAction("remove", this.id);
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
                start_stop_btn = new ControlButton("media-playback-start", null,
                                                   Lang.bind(this, this.start),
                                                   "small");
                break;
            default:
                start_stop_btn = new ControlButton("media-playback-pause", null,
                                                   Lang.bind(this, this.stop),
                                                   "small");
                break;
        }
        let remove_btn = new ControlButton("user-trash", null,
                                           Lang.bind(this, this.remove),
                                           "small");

        this.box.add(start_stop_btn.actor);
        this.box.add(remove_btn.actor);
    },
});

const TorrentsControls = new Lang.Class({
    Name: 'TorrentsControls',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function () {
        this.parent({reactive: false});

        this._old_info = "";
        this.hover = false;

        this.vbox = new St.BoxLayout({vertical: true,
                                      style_class: 'torrents-controls-vbox'});

        this.ctrl_box = new St.BoxLayout({vertical: false});

        this.ctrl_btns = new St.BoxLayout({vertical: false,
                                           style_class: 'torrents-controls'});
        this.ctrl_info = new St.Label({style_class: 'torrents-controls-text', 
                                       text: ''});
        this.ctrl_info.add_style_pseudo_class("inactive");


        this.ctrl_box.add(this.ctrl_btns);
        this.ctrl_box.add(this.ctrl_info, {expand: true,
                                           x_fill: false,
                                           y_fill: false,
                                           x_align: St.Align.END});

        this.vbox.add(this.ctrl_box, {expand: true, span: -1});

        this.addActor(this.vbox, {expand: true, span: -1});
    },

    setInfo: function(text) {
        if (!this.hover)
            this.ctrl_info.text = text;
    },

    addControl: function(button, position) {
        if (!this.ctrl_btns.contains(button.actor)) {
            if (position)
                this.ctrl_btns.insert_child_at_index(button.actor, position);
            else
                this.ctrl_btns.add_actor(button.actor);
            this.ctrl_info.remove_style_pseudo_class("inactive");
            button.actor.connect('notify::hover', Lang.bind(this, function(button) {
                this.hover = button.hover;
                if (this.hover) {
                    if (button._delegate._info != this.ctrl_info.text)
                        this._old_info = this.ctrl_info.text;
                    this.ctrl_info.text = button._delegate._info;
                }
                else
                    this.ctrl_info.text = this._old_info;
            }));
        }
    },

    removeControl: function(button, name) {
        let button_actor = button;
        if (button instanceof ControlButton)
            button_actor = button.actor;
        if (this.ctrl_btns.contains(button_actor))
            this.ctrl_btns.remove_actor(button_actor);
    },

    removeControls: function() {
        this.ctrl_btns.get_children().forEach(Lang.bind(this, function(b) {
            this.removeControl(b);
        }));
        this.ctrl_info.add_style_pseudo_class("inactive");
    }
});

const TorrentsTopControls = new Lang.Class({
    Name: 'TorrentsTopControls',
    Extends: TorrentsControls,

    _init: function () {
        this.parent({reactive: false});

        this.add_box = new St.BoxLayout({vertical: false,
                                         style_class: 'torrents-add'});
        this.add_box_btn = false;
        this.add_entry = new St.Entry({style_class: 'add-entry',
                                       hint_text: _("Torrent URL or Magnet link"),
                                       can_focus: true});
        this.add_btn = new ControlButton("object-select", "",
                                         Lang.bind(this, this.torrentAdd));
        this.add_box.hide();

        this.add_box.add(this.add_entry, {expand: true});
        this.add_box.add(this.add_btn.actor);

        this.ctrl_info.text = _("Connecting...");

        this.vbox.add(this.add_box, {expand: true, span: -1});
    },

    toggleAddEntry: function(button) {
        this.add_box_btn = button;
        if (this.add_box.visible)
            this.hideAddEntry();
        else {
            this.add_box.show();
            let [min_width, pref_width] = this.add_entry.get_preferred_width(-1);
            this.add_entry.width = pref_width;
            this.add_box_btn.actor.add_style_pseudo_class('active');
        }
    },

    hideAddEntry: function() {
        transmissionDaemonIndicator.menu.actor.grab_key_focus();
        this.add_entry.text = "";
        this.add_entry.remove_style_pseudo_class('error');
        this.add_entry.remove_style_pseudo_class('inactive');
        if (this.add_box_btn)
            this.add_box_btn.actor.remove_style_pseudo_class('active');
        this.add_box.hide();
    },

    torrentAdd: function() {
        let url = this.add_entry.text;
        if (url.match(/^http/) || url.match(/^magnet:/)) {
            this.add_entry.add_style_pseudo_class('inactive');
            transmissionDaemonMonitor.torrentAdd(url);
        }
        else {
            this.torrentAdded(false);
        }
    },

    torrentAdded: function(added) {
        if (added)
            this.hideAddEntry();
        else {
            this.add_entry.remove_style_pseudo_class('inactive');
            this.add_entry.add_style_pseudo_class('error');
        }
    },
});

const TorrentsBottomControls = new Lang.Class({
    Name: 'TorrentsBottomControls',
    Extends: TorrentsControls,

    _init: function () {
        this.parent({reactive: false});

        this._turtle_state = false;
        this._display_state = false;
    },

    toggleTurtleMode: function(button, state) {
        if (state == true || state == false)
            this._turtle_state = state;
        else {
            this._turtle_state = !this._turtle_state;
            transmissionDaemonMonitor.setAltSpeed(this._turtle_state);
        }

        if (this._turtle_state)
            button.actor.add_style_pseudo_class('active');
        else
            button.actor.remove_style_pseudo_class('active');
    },

    toggleDisplayMode: function(button, state) {
        if (state == true || state == false)
            this._display_state = state;
        else
            this._display_state = !this._display_state;

        if (this._display_state) {
            button.actor.add_style_pseudo_class('active');
            gsettings.set_enum(TDAEMON_TORRENTS_DISPLAY, TorrentDisplayClass.TransmissionTorrentSmall);
        }
        else {
            button.actor.remove_style_pseudo_class('active');
            gsettings.set_enum(TDAEMON_TORRENTS_DISPLAY, TorrentDisplayClass.TransmissionTorrent);
        }

        if (state != true && state != false) {
            let indicator = this._delegate._delegate;
            indicator.changeTorrentClass();
        }
    },
});


const ControlButton = new Lang.Class({
    Name: 'ControlButton',

    _init: function(icon, info, callback, type) {
        let icon_size = 20;
        let padding = 8;
        if (type && type == "small") {
            icon_size = 16;
            padding = 3;
        }

        this.icon = new St.Icon({
            icon_name: icon + "-symbolic",
            icon_size: icon_size,
        });

        this.actor = new St.Button({style_class: 'notification-icon-button',
                                    child: this.icon});
        this.actor._delegate = this;
        this.actor.connect('clicked', callback);

        // override base style
        this.icon.set_style('padding: 0px');
        this.actor.set_style('padding: %spx'.format(padding.toString()));

        this._info = info;
    },

    setIcon: function(icon) {
        this.icon.icon_name = icon + "-symbolic";
    }
});

const TorrentsFilters = new Lang.Class({
    Name: 'TorrentsFilters',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function() {
        this.parent({reactive: false, style_class: 'status-chooser'});

        this._combo = new PopupMenu.PopupComboBoxMenuItem(
                                        {style_class: 'status-chooser-combo'});
        let item;
        item = new PopupMenu.PopupMenuItem(_("All"));
        this._combo.addMenuItem(item, StatusFilter.ALL);
        item = new PopupMenu.PopupMenuItem(_("Active"));
        this._combo.addMenuItem(item, StatusFilter.ACTIVE);
        item = new PopupMenu.PopupMenuItem(_("Downloading"));
        this._combo.addMenuItem(item, StatusFilter.DOWNLOADING);
        item = new PopupMenu.PopupMenuItem(_("Seeding"));
        this._combo.addMenuItem(item, StatusFilter.SEEDING);
        item = new PopupMenu.PopupMenuItem(_("Paused"));
        this._combo.addMenuItem(item, StatusFilter.PAUSED);
        item = new PopupMenu.PopupMenuItem(_("Finished"));
        this._combo.addMenuItem(item, StatusFilter.FINISHED);

        this._combo.setActiveItem(gsettings.get_int(TDAEMON_LATEST_FILTER));
        this._combo.setSensitive(6);

        this._combo.connect('active-item-changed',
                            Lang.bind(this, this.filterByState));

        this.addActor(this._combo.actor);

    },

    filterByState: function() {
        for (let id in transmissionDaemonIndicator._torrents) {
            let torrent = transmissionDaemonIndicator._torrents[id];
            switch (this._combo._activeItemPos) {
                case StatusFilter.ALL:
                    torrent.show();
                    break;
                case StatusFilter.ACTIVE:
                    if (torrent._params.peersGettingFromUs > 0 ||
                        torrent._params.peersSendingToUs > 0 ||
                        torrent._params.webseedsSendingToUs > 0 ||
                        torrent._params.status == TransmissionStatus.CHECK)
                            torrent.show();
                    else
                        torrent.hide();
                    break;
                case StatusFilter.DOWNLOADING:
                    if (torrent._params.status == TransmissionStatus.DOWNLOAD)
                        torrent.show();
                    else
                        torrent.hide();
                    break;
                case StatusFilter.SEEDING:
                    if (torrent._params.status == TransmissionStatus.SEED)
                        torrent.show();
                    else
                        torrent.hide();
                    break;
                case StatusFilter.PAUSED:
                    if (torrent._params.status == TransmissionStatus.STOPPED &&
                        !torrent._params.isFinished)
                        torrent.show();
                    else
                        torrent.hide();
                    break;
                case StatusFilter.FINISHED:
                    if (torrent._params.status == TransmissionStatus.STOPPED &&
                        torrent._params.isFinished)
                        torrent.show();
                    else
                        torrent.hide();
                    break;
            }
        }
        gsettings.set_int(TDAEMON_LATEST_FILTER, this._combo._activeItemPos);
    },

    hide: function() {
        this.actor.hide();
    },

    show: function() {
        this.actor.show();
    }
});

const TorrentsMenu = new Lang.Class({
    Name: 'TorrentsMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(sourceActor) {
        this.parent(sourceActor, 0.0, St.Side.TOP);

        // override base style
        this._boxWrapper.set_style('min-width: 450px');

        this.controls = new TorrentsTopControls();
        this.filters = new TorrentsFilters();
        this.filters.hide();
        this.bottom_controls = new TorrentsBottomControls();
        this.bottom_controls._delegate = this;

        this._scroll = new St.ScrollView({style_class: 'vfade popup-sub-menu torrents-list',
                                          hscrollbar_policy: Gtk.PolicyType.NEVER,
                                          vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        this._scrollBox = new St.BoxLayout({vertical: true});
        this._scroll.add_actor(this._scrollBox);

        this.addMenuItem(this.controls);
        this.addMenuItem(this.filters);
        this.box.add(this._scroll);
        this.addMenuItem(this.bottom_controls);

        let vscroll = this._scroll.get_vscroll_bar();
        vscroll.connect('scroll-start', Lang.bind(this, function() {
                                            this.passEvents = true;
                                        }));
        vscroll.connect('scroll-stop', Lang.bind(this, function() {
                                            this.passEvents = false;
                                        }));
    },

    addMenuItem: function(menuItem, position) {
        if (menuItem instanceof TransmissionTorrent || menuItem instanceof TransmissionTorrentSmall) {
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
    },

    close: function(animate) {
        this.parent(animate);
        this.controls.hideAddEntry();
    }
});

const TorrentDisplayClasses = [TransmissionTorrent, TransmissionTorrentSmall];

let gsettings;
let transmissionDaemonMonitor;
let transmissionDaemonIndicator;

function init(extensionMeta) {
    gsettings = Lib.getSettings(Me);
    Lib.initTranslations(Me);
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

function timeInterval(secs) {
    var days    = Math.floor (secs / 86400),
        hours   = Math.floor ((secs % 86400) / 3600),
        minutes = Math.floor ((secs % 3600) / 60),
        seconds = Math.floor (secs % 60),
        d = days    + ' ' + (days    > 1 ? _('days')    : _('day')),
        h = hours   + ' ' + (hours   > 1 ? _('hours')   : _('hour')),
        m = minutes + ' ' + (minutes > 1 ? _('minutes') : _('minute')),
        s = seconds + ' ' + (seconds > 1 ? _('seconds') : _('second'));

    if (days) {
        if (days >= 4 || !hours)
            return d;
        return d + ', ' + h;
    }
    if (hours) {
        if (hours >= 4 || !minutes)
            return h;
        return h + ', ' + m;
    }
    if (minutes) {
        if (minutes >= 4 || !seconds)
            return m;
        return m + ', ' + s;
    }
    return s;
}
