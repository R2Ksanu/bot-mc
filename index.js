// dotenv for secrets
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const ping = require('ping');
const {
    Client, GatewayIntentBits, SlashCommandBuilder, Events,
    ChannelType, PermissionsBitField, EmbedBuilder, ButtonBuilder,
    ActionRowBuilder, ButtonStyle, AttachmentBuilder
} = require('discord.js');
const fetch = require('node-fetch');

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = '1365314109054255124';
const DISCORD_INVITE = 'https://discord.gg/Y9p5W5Bx';
const FIXED_IP = 'heartlessmc.playcraft.me';
const VPS_IP = '8.8.8.8';

if (!TOKEN) {
    console.error("❌ BOT_TOKEN not found in .env file");
    process.exit(1);
}

const db = new sqlite3.Database('./permissions.db', (err) => {
    if (err) console.error('❌ Database Error:', err.message);
    else console.log('✅ Connected to SQLite database.');
});

// Create permissions table
db.run(`CREATE TABLE IF NOT EXISTS permissions (
    guildId TEXT,
    commandName TEXT,
    roleId TEXT,
    PRIMARY KEY (guildId, commandName, roleId)
)`);

// Create warnings table
db.run(`CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT,
    userId TEXT,
    reason TEXT,
    moderatorId TEXT,
    timestamp INTEGER
)`);

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const setupChannels = new Map();
const statusCache = new Map();
const monitoringStatus = new Map();

client.once(Events.ClientReady, async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    const commands = [
        new SlashCommandBuilder().setName('setup').setDescription('Create a status channel.'),
        new SlashCommandBuilder().setName('stop').setDescription('Stop monitoring the server.'),
        new SlashCommandBuilder().setName('start').setDescription('Resume monitoring the server.'),
        new SlashCommandBuilder()
            .setName('msg').setDescription('Send maintenance or stop message')
            .addStringOption(opt => opt.setName('type').setDescription('Type').setRequired(true)
                .addChoices({ name: 'maintenance', value: 'maintenance' }, { name: 'server_stop', value: 'server_stop' }))
            .addStringOption(opt => opt.setName('time').setDescription('Estimated time').setRequired(true)),
        new SlashCommandBuilder()
            .setName('perm').setDescription('Allow/Deny role or reset permissions')
            .addRoleOption(opt => opt.setName('role').setDescription('Role'))
            .addStringOption(opt => opt.setName('permission').setDescription('Command')
                .addChoices(
                    { name: 'setup', value: 'setup' },
                    { name: 'stop', value: 'stop' },
                    { name: 'start', value: 'start' },
                    { name: 'msg', value: 'msg' },
                    { name: 'del', value: 'del' },
                    { name: 'perm', value: 'perm' },
                    { name: 'perm_list', value: 'perm_list' },
                    { name: 'ping', value: 'ping' },
                    { name: 'warn', value: 'warn' }
                ))
            .addStringOption(opt => opt.setName('toggle').setDescription('Allow or deny')
                .addChoices({ name: 'allow', value: 'allow' }, { name: 'deny', value: 'deny' }))
            .addBooleanOption(opt => opt.setName('reset').setDescription('Reset all permissions')),
        new SlashCommandBuilder().setName('perm_list').setDescription('List role permissions.'),
        new SlashCommandBuilder().setName('del').setDescription('Delete channel messages (admin only)'),
        new SlashCommandBuilder().setName('ping').setDescription('Check bot and VPS ping'),
        new SlashCommandBuilder().setName('test').setDescription('Test command'),
        new SlashCommandBuilder()
            .setName('warn')
            .setDescription('Warn a user with a reason')
            .addUserOption(opt => opt.setName('user').setDescription('User to warn').setRequired(true))
            .addStringOption(opt => opt.setName('reason').setDescription('Reason for the warning').setRequired(true))
    ].map(cmd => cmd.setDMPermission(false).toJSON());

    await client.application.commands.set(commands, GUILD_ID);
    console.log('📡 Commands registered.');

    setInterval(async () => {
        for (const [guildId, channelId] of setupChannels.entries()) {
            if (!monitoringStatus.get(guildId)) continue;
            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel) continue;

                const response = await fetch(`https://api.mcsrvstat.us/2/${FIXED_IP}`);
                const data = await response.json();

                if (!data || !data.online) {
                    await channel.send(`❌ Server ${FIXED_IP} is offline.`);
                    continue;
                }

                const status = {
                    status: 'online',
                    name: data.hostname || FIXED_IP,
                    players: `${data.players.online}/${data.players.max}`,
                    version: data.version,
                    motd: data.motd.clean.join('\n'),
                    protocol: data.protocol || 'Unknown',
                    icon: data.icon ? Buffer.from(data.icon.split(',')[1], 'base64') : null
                };

                const msgPayload = formatStatusMessage(status, FIXED_IP);
                const lastMsgId = statusCache.get(guildId);

                if (lastMsgId) {
                    try {
                        const lastMsg = await channel.messages.fetch(lastMsgId);
                        await lastMsg.edit(msgPayload);
                        continue;
                    } catch {}
                }

                const sent = await channel.send(msgPayload);
                statusCache.set(guildId, sent.id);
            } catch (err) {
                console.error('Monitoring error:', err);
            }
        }
    }, 5000);
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        const { commandName, options, guild } = interaction;
        const member = await guild.members.fetch(interaction.user.id);

        if (!await hasPermission(guild.id, commandName, member)) {
            return interaction.reply({ content: '⛔ No permission for this command.', ephemeral: true });
        }

        if (commandName === 'ping') {
            const vpsPingResult = await ping.promise.probe(VPS_IP);
            const botPing = Date.now() - interaction.createdTimestamp;
            const apiPing = client.ws.ping;
            const vpsPing = vpsPingResult.time !== 'unknown' ? `${vpsPingResult.time} ms` : 'Unreachable';

            const embed = new EmbedBuilder()
                .setTitle('🏓 Pong!')
                .addFields(
                    { name: '🤖 Bot Latency', value: `${botPing} ms`, inline: true },
                    { name: '📡 API Latency', value: `${apiPing} ms`, inline: true },
                    { name: '🖥️ VPS Ping', value: `${vpsPing}`, inline: true }
                )
                .setColor(0x00FF00)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }

        else if (commandName === 'test') {
            await interaction.reply({ content: '✅ Test command is working!' });
        }

        else if (commandName === 'setup') {
            const channel = await guild.channels.create({
                name: 'server-status',
                type: ChannelType.GuildText,
                reason: 'Minecraft Server Status Channel'
            });
            setupChannels.set(guild.id, channel.id);
            monitoringStatus.set(guild.id, true);
            await interaction.reply({ content: `✅ Status channel created: ${channel}`, ephemeral: true });
        }

        else if (commandName === 'start') {
            if (!setupChannels.has(guild.id)) {
                await interaction.reply({ content: '⚠️ Please run `/setup` first.', ephemeral: true });
            } else {
                monitoringStatus.set(guild.id, true);
                await interaction.reply({ content: '✅ Monitoring started.', ephemeral: true });
            }
        }

        else if (commandName === 'stop') {
            if (!setupChannels.has(guild.id)) {
                await interaction.reply({ content: '⚠️ Please run `/setup` first.', ephemeral: true });
            } else {
                monitoringStatus.set(guild.id, false);
                await interaction.reply({ content: '⏸️ Monitoring stopped.', ephemeral: true });
            }
        }

        else if (commandName === 'msg') {
            const type = options.getString('type');
            const time = options.getString('time');

            const embed = new EmbedBuilder()
                .setColor(type === 'maintenance' ? 0xFFA500 : 0xFF0000)
                .setTitle(type === 'maintenance' ? '🚧 Scheduled Maintenance' : '🛑 Server Downtime Notice')
                .setDescription(type === 'maintenance'
                    ? `🛠️ **The server is currently undergoing maintenance.**\n\nEstimated time to complete: **${time}**\nWe appreciate your patience and support.`
                    : `❌ **The server has been stopped temporarily.**\n\nEstimated downtime: **${time}**\nWe'll notify everyone when it's back online.`)
                .setThumbnail('https://i.imgur.com/zlQwjWe.png')
                .setFooter({ text: 'Status Bot Notification • HeartlessMC' })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Join Discord for Updates')
                    .setStyle(ButtonStyle.Link)
                    .setURL(DISCORD_INVITE)
                    .setEmoji('🔗')
            );

            await interaction.reply({ embeds: [embed], components: [row] });
        }

        else if (commandName === 'perm') {
            const reset = options.getBoolean('reset');
            if (reset) {
                db.run(`DELETE FROM permissions WHERE guildId = ?`, [guild.id], async (err) => {
                    if (err) return interaction.reply({ content: '❌ Failed to reset permissions.', ephemeral: true });
                    return interaction.reply({ content: '♻️ All permissions have been reset.', ephemeral: true });
                });
                return;
            }

            const role = options.getRole('role');
            const permission = options.getString('permission');
            const toggle = options.getString('toggle');

            if (!role || !permission || !toggle)
                return interaction.reply({ content: '⚠️ Missing arguments. Use `reset: true` to reset all.', ephemeral: true });

            if (toggle === 'allow') {
                db.run(`INSERT OR IGNORE INTO permissions(guildId, commandName, roleId) VALUES (?, ?, ?)`, [guild.id, permission, role.id]);
                await interaction.reply({ content: `✅ Allowed ${role} to use \`/${permission}\`.`, ephemeral: true });
            } else {
                db.run(`DELETE FROM permissions WHERE guildId = ? AND commandName = ? AND roleId = ?`, [guild.id, permission, role.id]);
                await interaction.reply({ content: `⛔ Denied ${role} from using \`/${permission}\`.`, ephemeral: true });
            }
        }

        else if (commandName === 'perm_list') {
            db.all(`SELECT * FROM permissions WHERE guildId = ?`, [guild.id], async (err, rows) => {
                if (err) return interaction.reply({ content: '❌ Database error.', ephemeral: true });
                if (!rows.length) return interaction.reply({ content: 'ℹ️ No permissions set.', ephemeral: true });

                const perms = rows.map(r => `• \`${r.commandName}\`: <@&${r.roleId}>`).join('\n');
                await interaction.reply({ content: `📋 **Permissions:**\n${perms}`, ephemeral: true });
            });
        }

        else if (commandName === 'del') {
            const channel = interaction.channel;
            if (!channel.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.ManageMessages)) {
                return interaction.reply({ content: '❌ I need the Manage Messages permission.', ephemeral: true });
            }
            const messages = await channel.messages.fetch({ limit: 100 });
            await channel.bulkDelete(messages);
            await interaction.reply({ content: '🗑️ Deleted messages.', ephemeral: true });
        }

        else if (commandName === 'warn') {
            const user = options.getUser('user');
            const reason = options.getString('reason');
            const timestamp = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

            // Prevent warning the bot itself or the command issuer
            if (user.id === client.user.id) {
                return interaction.reply({ content: '❌ I cannot warn myself!', ephemeral: true });
            }
            if (user.id === interaction.user.id) {
                return interaction.reply({ content: '❌ You cannot warn yourself!', ephemeral: true });
            }

            // Store the warning in the database
            db.run(
                `INSERT INTO warnings (guildId, userId, reason, moderatorId, timestamp) VALUES (?, ?, ?, ?, ?)`,
                [guild.id, user.id, reason, interaction.user.id, timestamp],
                async (err) => {
                    if (err) {
                        console.error('Database error:', err);
                        return interaction.reply({ content: '❌ Failed to save warning.', ephemeral: true });
                    }

                    // Create the warning embed
                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ User Warned')
                        .setDescription(`**User:** ${user}\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}`)
                        .setColor(0xFFA500)
                        .setTimestamp();

                    // Send warning notification to the user (if possible)
                    try {
                        await user.send({
                            embeds: [
                                new EmbedBuilder()
                                    .setTitle('⚠️ You Have Been Warned')
                                    .setDescription(`**Server:** ${guild.name}\n**Reason:** ${reason}\nPlease follow the server rules to avoid further actions.`)
                                    .setColor(0xFFA500)
                                    .setTimestamp()
                            ]
                        });
                    } catch (err) {
                        console.log(`Could not DM ${user.tag}: ${err.message}`);
                    }

                    // Reply to the command issuer
                    await interaction.reply({ embeds: [embed], ephemeral: true });

                    // Optionally, send the warning to the status channel if set up
                    const statusChannelId = setupChannels.get(guild.id);
                    if (statusChannelId) {
                        try {
                            const channel = await client.channels.fetch(statusChannelId);
                            await channel.send({ embeds: [embed] });
                        } catch (err) {
                            console.error(`Failed to send warning to status channel: ${err.message}`);
                        }
                    }
                }
            );
        }

    } catch (err) {
        console.error(err);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: '❌ Something went wrong.', ephemeral: true });
        } else {
            await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
        }
    }
});

function hasPermission(guildId, commandName, member) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT roleId FROM permissions WHERE guildId = ? AND commandName = ?`, [guildId, commandName], (err, rows) => {
            if (err) return reject(err);
            if (!rows.length) return resolve(true);
            const allowed = rows.some(r => member.roles.cache.has(r.roleId));
            resolve(allowed);
        });
    });
}

function formatStatusMessage(status, ip) {
    const embed = new EmbedBuilder()
        .setTitle(`🟢 ${String(status.name)}`)
        .addFields(
            { name: '📊 Status', value: String(capitalize(status.status)), inline: true },
            { name: '👥 Players', value: String(status.players), inline: true },
            { name: '📦 Version', value: String(status.version || 'Unknown'), inline: true },
            { name: '🌐 IP', value: String(ip) },
            { name: '📜 MOTD', value: String(status.motd || 'N/A').slice(0, 1024) },
            { name: '🔗 Protocol', value: String(status.protocol || 'Unknown') }
        )
        .setColor(0x00FF00)
        .setFooter({ text: 'Last Updated' })
        .setTimestamp();

    const files = [];
    if (status.icon) {
        const attachment = new AttachmentBuilder(status.icon, { name: 'server-icon.png' });
        embed.setThumbnail('attachment://server-icon.png');
        files.push(attachment);
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Join Server')
            .setStyle(ButtonStyle.Link)
            .setURL(DISCORD_INVITE)
            .setEmoji('🌐')
    );

    return { embeds: [embed], files, components: [row] };
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));

client.login(TOKEN);