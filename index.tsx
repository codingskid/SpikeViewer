import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { DataStore } from "@api/index";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, GuildStore, UserStore, GuildMemberStore, PermissionStore, FluxDispatcher, Menu, React } from "@webpack/common";

// ============== CONSTANTS ==============
const PERMISSIONS = {
    VIEW_CHANNEL: 1n << 10n,
    READ_MESSAGE_HISTORY: 1n << 16n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_ROLES: 1n << 28n,
    MANAGE_GUILD: 1n << 5n,
    CONNECT: 1n << 20n,
    SPEAK: 1n << 21n,
    ADMINISTRATOR: 1n << 3n,
};
const RATE_LIMITS: any = { conservative: 2000, moderate: 1000, aggressive: 333 };
const STORAGE_KEYS = {
    DELETED_MESSAGES: "spikeviewer-deleted-messages",
    USER_CACHE: "spikeviewer-user-cache",
    PRESENCE_HISTORY: "spikeviewer-presence-history"
};

// ============== SETTINGS ==============
const settings = definePluginSettings({
    showHiddenChannels: { type: OptionType.BOOLEAN, description: "Show hidden channels (metadata only)", default: true },
    fullMemberList: { type: OptionType.BOOLEAN, description: "Force-load full member lists", default: true },
    revealVoiceMembers: { type: OptionType.BOOLEAN, description: "Show members in unjoinable VCs", default: true },
    cacheDeletedMessages: { type: OptionType.BOOLEAN, description: "Cache and show deleted messages", default: true },
    deletedMessageRetention: { type: OptionType.NUMBER, description: "Messages to keep per channel", default: 1000 },
    userEnrichment: { type: OptionType.BOOLEAN, description: "Show user dossiers", default: true },
    invitePreview: { type: OptionType.BOOLEAN, description: "Hover invite previews", default: true },
    presenceTracking: { type: OptionType.BOOLEAN, description: "Track presence changes", default: false },
    permissionViewer: { type: OptionType.BOOLEAN, description: "Permission breakdown context menu", default: true },
    rateLimitMode: {
        type: OptionType.SELECT,
        description: "API call rate (lower = safer)",
        options: [
            { label: "Conservative (1/2s)", value: "conservative", default: true },
            { label: "Moderate (1/s)", value: "moderate" },
            { label: "Aggressive (3/s)", value: "aggressive" }
        ]
    }
});

// ============== RATE LIMITER ==============
class RateLimiter {
    private queue: (() => Promise<any>)[] = [];
    private processing = false;
    private getDelay() {
        const mode = settings.store.rateLimitMode || "conservative";
        return RATE_LIMITS[mode] || 2000;
    }
    async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try { resolve(await fn()); } catch (e) { reject(e); }
            });
            this.process();
        });
    }
    private async process() {
        if (this.processing) return;
        this.processing = true;
        while (this.queue.length > 0) {
            const fn = this.queue.shift();
            if (fn) {
                await fn();
                await new Promise(r => setTimeout(r, this.getDelay()));
            }
        }
        this.processing = false;
    }
}
const rateLimiter = new RateLimiter();

// ============== API ==============
const RestAPI = findByPropsLazy("getAPIBaseURL", "get");

async function fetchInviteInfo(code: string) {
    return rateLimiter.enqueue(async () => {
        try {
            const r = await RestAPI.get({ url: `/invites/${code}?with_counts=true&with_expiration=true` });
            return r.body;
        } catch { return null; }
    });
}

async function fetchUserProfile(userId: string, guildId?: string) {
    return rateLimiter.enqueue(async () => {
        try {
            const url = guildId
                ? `/users/${userId}/profile?guild_id=${guildId}&with_mutual_guilds=true`
                : `/users/${userId}/profile?with_mutual_guilds=true`;
            const r = await RestAPI.get({ url });
            return r.body;
        } catch { return null; }
    });
}

async function fetchGuildMembersChunk(guildId: string, query = "", limit = 100) {
    return rateLimiter.enqueue(async () => {
        try {
            const r = await RestAPI.get({ url: `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=${limit}` });
            return r.body;
        } catch { return []; }
    });
}

// ============== PERMISSIONS UTIL ==============
function canViewChannel(channelId: string): boolean {
    try { return PermissionStore.can(PERMISSIONS.VIEW_CHANNEL, { id: channelId }); }
    catch { return false; }
}

function getChannelPermissionOverwrites(channel: any) {
    if (!channel?.permissionOverwrites) return { roles: [], users: [] };
    const guild = GuildStore.getGuild(channel.guild_id);
    if (!guild) return { roles: [], users: [] };
    const result: any = { roles: [], users: [] };
    for (const id in channel.permissionOverwrites) {
        const ow = channel.permissionOverwrites[id];
        const allow = BigInt(ow.allow || 0);
        const deny = BigInt(ow.deny || 0);
        if (ow.type === 0) {
            const role = guild.roles[id];
            if (role) result.roles.push({
                id, name: role.name, color: role.color,
                canView: (allow & PERMISSIONS.VIEW_CHANNEL) !== 0n,
                cantView: (deny & PERMISSIONS.VIEW_CHANNEL) !== 0n,
                allow, deny
            });
        } else {
            const user = UserStore.getUser(id);
            result.users.push({
                id, username: user?.username || "Unknown",
                canView: (allow & PERMISSIONS.VIEW_CHANNEL) !== 0n,
                cantView: (deny & PERMISSIONS.VIEW_CHANNEL) !== 0n,
                allow, deny
            });
        }
    }
    return result;
}

function permissionsToReadable(perms: bigint): string[] {
    const r: string[] = [];
    if ((perms & PERMISSIONS.ADMINISTRATOR) !== 0n) r.push("Administrator");
    if ((perms & PERMISSIONS.VIEW_CHANNEL) !== 0n) r.push("View Channel");
    if ((perms & PERMISSIONS.READ_MESSAGE_HISTORY) !== 0n) r.push("Read History");
    if ((perms & PERMISSIONS.SEND_MESSAGES) !== 0n) r.push("Send Messages");
    if ((perms & PERMISSIONS.MANAGE_CHANNELS) !== 0n) r.push("Manage Channels");
    if ((perms & PERMISSIONS.MANAGE_ROLES) !== 0n) r.push("Manage Roles");
    if ((perms & PERMISSIONS.MANAGE_GUILD) !== 0n) r.push("Manage Guild");
    if ((perms & PERMISSIONS.CONNECT) !== 0n) r.push("Connect");
    if ((perms & PERMISSIONS.SPEAK) !== 0n) r.push("Speak");
    return r;
}

// ============== HIDDEN CHANNELS ==============
const hiddenChannelCache = new Map<string, any[]>();

function getAllChannelsIncludingHidden(guildId: string) {
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return { count: 0, SELECTABLE: [], VOCAL: [], HIDDEN: [] };
    const all = Object.values(ChannelStore.getMutableGuildChannelsForGuild(guildId) || {});
    const visible: any[] = [], hidden: any[] = [];
    for (const c of all) {
        const ch: any = c;
        if (canViewChannel(ch.id)) visible.push(ch);
        else hidden.push({ ...ch, __hidden: true, __hiddenReason: getHiddenReason(ch) });
    }
    hiddenChannelCache.set(guildId, hidden);
    return {
        count: visible.length + hidden.length,
        SELECTABLE: visible.filter((c: any) => [0, 5, 15].includes(c.type)),
        VOCAL: visible.filter((c: any) => [2, 13].includes(c.type)),
        HIDDEN: hidden
    };
}

function getHiddenReason(ch: any): string {
    const ow = ch.permissionOverwrites || {};
    for (const id in ow) {
        const deny = BigInt(ow[id].deny || 0);
        if ((deny & PERMISSIONS.VIEW_CHANNEL) !== 0n)
            return `Denied by ${ow[id].type === 0 ? "role" : "user"} override`;
    }
    return "Permission denied";
}

// ============== MEMBER LIST ==============
const memberCache = new Map<string, any[]>();
let memberListListener: any;

function initMemberList() {
    memberListListener = (e: any) => {
        if (e.type === "GUILD_MEMBER_LIST_UPDATE") {
            const c = memberCache.get(e.guildId) || [];
            for (const op of e.ops || []) {
                if (op.op === "SYNC" && op.items)
                    for (const item of op.items) if (item.member) c.push(item.member);
            }
            memberCache.set(e.guildId, c);
        }
    };
    FluxDispatcher.subscribe("GUILD_MEMBER_LIST_UPDATE", memberListListener);
}

function cleanupMemberList() {
    if (memberListListener) FluxDispatcher.unsubscribe("GUILD_MEMBER_LIST_UPDATE", memberListListener);
    memberCache.clear();
}

// ============== VOICE REVEAL ==============
const VoiceStateStore = findStoreLazy("VoiceStateStore");
const voiceLog = new Map<string, any[]>();
let voiceListener: any;

function initVoiceReveal() {
    voiceListener = (e: any) => {
        if (e.type === "VOICE_STATE_UPDATES") {
            for (const s of e.voiceStates || []) {
                if (!s.channelId) continue;
                const l = voiceLog.get(s.channelId) || [];
                l.push({
                    userId: s.userId, timestamp: Date.now(),
                    muted: s.mute || s.selfMute, deafened: s.deaf || s.selfDeaf,
                    streaming: s.selfStream, video: s.selfVideo
                });
                if (l.length > 500) l.shift();
                voiceLog.set(s.channelId, l);
            }
        }
    };
    FluxDispatcher.subscribe("VOICE_STATE_UPDATES", voiceListener);
}

function cleanupVoiceReveal() {
    if (voiceListener) FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", voiceListener);
    voiceLog.clear();
}

function getVoiceMembersForChannel(channelId: string) {
    try {
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
        return states ? Object.values(states) : [];
    } catch { return []; }
}

// ============== DELETED MESSAGES ==============
const msgCache = new Map<string, Map<string, any>>();
const deletedMsgs = new Map<string, any[]>();
let createL: any, deleteL: any, updateL: any;

async function initDeletedMessages() {
    const stored = await DataStore.get(STORAGE_KEYS.DELETED_MESSAGES);
    if (stored) for (const [k, v] of Object.entries(stored)) deletedMsgs.set(k, v as any[]);

    createL = (e: any) => {
        if (!e.message?.channel_id) return;
        let c = msgCache.get(e.message.channel_id);
        if (!c) { c = new Map(); msgCache.set(e.message.channel_id, c); }
        c.set(e.message.id, { ...e.message });
        const max = settings.store.deletedMessageRetention || 1000;
        if (c.size > max) {
            const k = c.keys().next().value;
            if (k) c.delete(k);
        }
    };
    deleteL = (e: any) => {
        const c = msgCache.get(e.channelId)?.get(e.id);
        if (c) {
            const l = deletedMsgs.get(e.channelId) || [];
            l.push({ ...c, deletedAt: Date.now() });
            const max = settings.store.deletedMessageRetention || 1000;
            if (l.length > max) l.shift();
            deletedMsgs.set(e.channelId, l);
            persistDeleted();
        }
    };
    updateL = (e: any) => {
        if (e.message?.channel_id && e.message?.id) {
            const c = msgCache.get(e.message.channel_id)?.get(e.message.id);
            if (c) {
                const edits = c.__edits || [];
                edits.push({ content: c.content, editedAt: Date.now() });
                c.__edits = edits;
                c.content = e.message.content;
            }
        }
    };
    FluxDispatcher.subscribe("MESSAGE_CREATE", createL);
    FluxDispatcher.subscribe("MESSAGE_DELETE", deleteL);
    FluxDispatcher.subscribe("MESSAGE_UPDATE", updateL);
}

function cleanupDeletedMessages() {
    if (createL) FluxDispatcher.unsubscribe("MESSAGE_CREATE", createL);
    if (deleteL) FluxDispatcher.unsubscribe("MESSAGE_DELETE", deleteL);
    if (updateL) FluxDispatcher.unsubscribe("MESSAGE_UPDATE", updateL);
}

async function persistDeleted() {
    const o: any = {};
    for (const [k, v] of deletedMsgs.entries()) o[k] = v;
    await DataStore.set(STORAGE_KEYS.DELETED_MESSAGES, o);
}

function getDeletedMessages(channelId: string) { return deletedMsgs.get(channelId) || []; }

// ============== USER ENRICHMENT ==============
const userCache = new Map<string, any>();

async function initUserEnrichment() {
    const stored = await DataStore.get(STORAGE_KEYS.USER_CACHE);
    if (stored) for (const [k, v] of Object.entries(stored)) userCache.set(k, v);
}

async function persistUsers() {
    const o: any = {};
    for (const [k, v] of userCache.entries()) o[k] = v;
    await DataStore.set(STORAGE_KEYS.USER_CACHE, o);
}

async function buildUserDossier(userId: string, guildId?: string) {
    const c = userCache.get(userId);
    if (c && Date.now() - c.lastFetched < 3600000) return c;
    const user = UserStore.getUser(userId);
    const profile = await fetchUserProfile(userId, guildId);
    const d = {
        id: userId,
        username: user?.username,
        discriminator: user?.discriminator,
        globalName: (user as any)?.globalName,
        bot: user?.bot || false,
        accountCreated: user ? new Date(Number((BigInt(user.id) >> 22n) + 1420070400000n)) : null,
        bio: profile?.user_profile?.bio || null,
        accentColor: profile?.user?.accent_color || null,
        badges: profile?.badges || [],
        mutualGuilds: profile?.mutual_guilds || [],
        mutualFriends: profile?.mutual_friends_count || 0,
        connectedAccounts: profile?.connected_accounts || [],
        premiumSince: profile?.premium_since || null,
        premiumGuildSince: profile?.premium_guild_since || null,
        guildMember: guildId ? GuildMemberStore.getMember(guildId, userId) : null,
        lastFetched: Date.now()
    };
    userCache.set(userId, d);
    persistUsers();
    return d;
}

// ============== INVITE INSPECTOR ==============
const inviteCache = new Map<string, any>();
let inviteHandler: any;

function initInviteInspector() {
    inviteHandler = (e: MouseEvent) => {
        const t = e.target as HTMLElement;
        const link = t?.closest?.('a[href*="discord.gg"], a[href*="discord.com/invite"]') as HTMLAnchorElement;
        if (!link) return;
        const m = link.href.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9-]+)/);
        const code = m ? m[1] : null;
        if (code) showInvitePreview(code, link);
    };
    document.addEventListener("mouseover", inviteHandler);
}

function cleanupInviteInspector() {
    if (inviteHandler) document.removeEventListener("mouseover", inviteHandler);
    document.getElementById("spikeviewer-tooltip")?.remove();
}

async function showInvitePreview(code: string, anchor: HTMLAnchorElement) {
    let info = inviteCache.get(code);
    if (!info) { info = await fetchInviteInfo(code); if (info) inviteCache.set(code, info); }
    if (!info) return;
    document.getElementById("spikeviewer-tooltip")?.remove();
    const t = document.createElement("div");
    t.id = "spikeviewer-tooltip";
    t.style.cssText = "position:fixed;background:#2b2d31;color:#fff;padding:12px;border-radius:8px;border:1px solid #1e1f22;font-size:13px;z-index:99999;box-shadow:0 8px 16px rgba(0,0,0,0.4);pointer-events:none;max-width:320px;";
    const g = info.guild || {};
    const esc = (s: string) => s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!));
    t.innerHTML = `<div style="font-weight:bold;font-size:14px;margin-bottom:4px;">${esc(g.name || "Unknown")}</div>
<div style="color:#b5bac1;margin-bottom:6px;">${esc(g.description || "No description")}</div>
<div>Members: <b>${info.approximate_member_count || 0}</b> (${info.approximate_presence_count || 0} online)</div>
<div>Boosts: ${g.premium_subscription_count || 0}</div>
${info.expires_at ? `<div>Expires: ${new Date(info.expires_at).toLocaleString()}</div>` : "<div>Never expires</div>"}
${g.vanity_url_code ? `<div>Vanity: discord.gg/${g.vanity_url_code}</div>` : ""}
${info.inviter ? `<div>Inviter: ${esc(info.inviter.username)}</div>` : ""}`;
    document.body.appendChild(t);
    const r = anchor.getBoundingClientRect();
    t.style.left = `${r.left}px`;
    t.style.top = `${r.bottom + 6}px`;
    anchor.addEventListener("mouseleave", () => t.remove(), { once: true });
}

// ============== PRESENCE TRACKER ==============
const presenceHistory = new Map<string, any[]>();
let presenceListener: any;

async function initPresenceTracker() {
    const stored = await DataStore.get(STORAGE_KEYS.PRESENCE_HISTORY);
    if (stored) for (const [k, v] of Object.entries(stored)) presenceHistory.set(k, v as any[]);
    presenceListener = (e: any) => {
        const log = (p: any) => {
            const id = p.user?.id || p.userId;
            if (!id) return;
            const h = presenceHistory.get(id) || [];
            const last = h[h.length - 1];
            if (!last || last.status !== p.status) {
                h.push({ status: p.status, activities: p.activities || [], timestamp: Date.now() });
                if (h.length > 500) h.shift();
                presenceHistory.set(id, h);
            }
        };
        if (e.type === "PRESENCE_UPDATES") for (const p of e.updates || []) log(p);
        else if (e.type === "PRESENCE_UPDATE") log(e);
    };
    FluxDispatcher.subscribe("PRESENCE_UPDATES", presenceListener);
    FluxDispatcher.subscribe("PRESENCE_UPDATE", presenceListener);
}

function cleanupPresenceTracker() {
    if (presenceListener) {
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", presenceListener);
        FluxDispatcher.unsubscribe("PRESENCE_UPDATE", presenceListener);
    }
    const o: any = {};
    for (const [k, v] of presenceHistory.entries()) o[k] = v;
    DataStore.set(STORAGE_KEYS.PRESENCE_HISTORY, o);
}

// ============== CONTEXT MENUS ==============
const ChannelInfoContextMenu = (children: any[], { channel }: any) => {
    if (!channel) return;
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id="sv-info" label="Channel Info" action={() => {
            alert(`Channel: #${channel.name}\nID: ${channel.id}\nType: ${channel.type}\nTopic: ${channel.topic || "(none)"}\nNSFW: ${channel.nsfw ? "Yes" : "No"}\nSlowmode: ${channel.rateLimitPerUser || 0}s\nPosition: ${channel.position}\nParent: ${channel.parent_id || "(none)"}\nBitrate: ${channel.bitrate || "N/A"}\nUser Limit: ${channel.userLimit || "N/A"}`);
        }} />,
        <Menu.MenuItem id="sv-perms" label="Permission Breakdown" action={() => {
            const { roles, users } = getChannelPermissionOverwrites(channel);
            let t = `Permissions for #${channel.name}\n\n=== ROLES ===\n`;
            for (const r of roles) {
                t += `\n[${r.name}]\n`;
                if (r.canView) t += "  Can View\n";
                if (r.cantView) t += "  Cannot View\n";
                t += `  Allow: ${permissionsToReadable(r.allow).join(", ") || "none"}\n`;
                t += `  Deny: ${permissionsToReadable(r.deny).join(", ") || "none"}\n`;
            }
            t += "\n=== USERS ===\n";
            for (const u of users) {
                t += `\n@${u.username}\n`;
                if (u.canView) t += "  Can View\n";
                if (u.cantView) t += "  Cannot View\n";
            }
            alert(t);
        }} />,
        <Menu.MenuItem id="sv-deleted" label="Deleted Messages" action={() => {
            const d = getDeletedMessages(channel.id);
            if (d.length === 0) return alert("No deleted messages cached.");
            let t = `Deleted in #${channel.name} (${d.length})\n\n`;
            for (const m of d.slice(-20))
                t += `[${new Date(m.deletedAt).toLocaleString()}] ${m.author?.username || "?"}: ${m.content}\n`;
            alert(t);
        }} />,
        <Menu.MenuItem id="sv-voice" label="Voice Activity" action={() => {
            const cur = getVoiceMembersForChannel(channel.id);
            const h = voiceLog.get(channel.id) || [];
            let t = `Voice: ${channel.name}\n\nCURRENT (${cur.length}):\n`;
            for (const s of cur) {
                const x: any = s;
                t += `${x.userId}${x.mute ? " [muted]" : ""}${x.deaf ? " [deaf]" : ""}\n`;
            }
            t += `\nHISTORY (${h.length}):\n`;
            for (const e of h.slice(-15))
                t += `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.userId}\n`;
            alert(t);
        }} />
    );
};

const UserDossierContextMenu = (children: any[], { user, guildId }: any) => {
    if (!user) return;
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id="sv-dossier" label="User Dossier" action={async () => {
            const d = await buildUserDossier(user.id, guildId);
            alert(`USER DOSSIER\nName: ${d.globalName || d.username}\nID: ${d.id}\nBot: ${d.bot ? "Yes" : "No"}\nAccount Created: ${d.accountCreated?.toLocaleString() || "?"}\n\nBio: ${d.bio || "(none)"}\n\nMutual Servers: ${d.mutualGuilds.length}\nMutual Friends: ${d.mutualFriends}\n\nConnected: ${d.connectedAccounts.map((a: any) => a.type + ":" + a.name).join(", ") || "(none)"}\n\nBadges: ${d.badges.map((b: any) => b.id).join(", ") || "(none)"}`);
        }} />
    );
};

// ============== PLUGIN DEFINITION ==============
export default definePlugin({
    name: "SpikeViewer",
    description: "Reveal hidden channels, deleted messages, full member lists, voice members, permission breakdowns, and user dossiers.",
    authors: [{ name: "Spikey", id: 0n }],
    dependencies: ["MessageAccessoriesAPI", "ContextMenuAPI"],
    settings,
    patches: [
        {
            find: '"GuildChannelStore"',
            replacement: {
                match: /(getChannels$$\i$${)/,
                replace: "$1if($self.shouldShowHidden())return $self.getAllChannels(arguments[0]);"
            }
        },
        {
            find: '"MemberListStore"',
            replacement: {
                match: /(isLazy$$$${)/,
                replace: "$1if($self.settings.store.fullMemberList)return false;"
            }
        }
    ],
    shouldShowHidden() { return settings.store.showHiddenChannels; },
    getAllChannels(guildId: string) { return getAllChannelsIncludingHidden(guildId); },
    start() {
        if (settings.store.fullMemberList) initMemberList();
        if (settings.store.revealVoiceMembers) initVoiceReveal();
        if (settings.store.cacheDeletedMessages) initDeletedMessages();
        if (settings.store.userEnrichment) initUserEnrichment();
        if (settings.store.invitePreview) initInviteInspector();
        if (settings.store.presenceTracking) initPresenceTracker();
        addContextMenuPatch("channel-context", ChannelInfoContextMenu);
        addContextMenuPatch("user-context", UserDossierContextMenu);
        console.log("[SpikeViewer] Loaded");
    },
    stop() {
        cleanupMemberList();
        cleanupVoiceReveal();
        cleanupDeletedMessages();
        cleanupInviteInspector();
        cleanupPresenceTracker();
        removeContextMenuPatch("channel-context", ChannelInfoContextMenu);
        removeContextMenuPatch("user-context", UserDossierContextMenu);
        console.log("[SpikeViewer] Unloaded");
    }
});
