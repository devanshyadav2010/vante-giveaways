const { EventEmitter } = require('node:events');
const { setTimeout, setInterval } = require('node:timers');
const { writeFile, readFile, access } = require('node:fs/promises');

const Discord = require('discord.js');
const serialize = require('serialize-javascript');
const { deepmerge } = require('deepmerge-ts');

const {
    GiveawayMessages,
    GiveawayEditOptions,
    GiveawayData,
    GiveawayRerollOptions,
    GiveawaysManagerOptions,
    GiveawayStartOptions,
    PauseOptions,
    MessageObject,
    DEFAULT_CHECK_INTERVAL,
    DELETE_DROP_DATA_AFTER
} = require('./Constants.js');
const Giveaway = require('./Giveaway.js');
const { validateEmbedColor, embedEqual } = require('./utils.js');

/**
 * Giveaways Manager
 */
class GiveawaysManager extends EventEmitter {
    /**
     * @param {Discord.Client} client The Discord Client
     * @param {GiveawaysManagerOptions} [options] The manager options
     * @param {boolean} [init=true] If the manager should start automatically. If set to "false", for example to create a delay, the manager can be started manually with "manager._init()".
     */
    constructor(client, options, init = true) {
        super();
        if (!client?.options) throw new Error(`Client is a required option. (val=${client})`);

        /**
         * The Discord Client
         * @type {Discord.Client}
         */
        this.client = client;
        /**
         * Whether the manager is ready
         * @type {boolean}
         */
        this.ready = false;
        /**
         * The giveaways managed by this manager
         * @type {Giveaway[]}
         */
        this.giveaways = [];
        /**
         * The manager options
         * @type {GiveawaysManagerOptions}
         */
        this.options = deepmerge(GiveawaysManagerOptions, options || {});

        if (init) this._init();
    }

    /**
     * Generate an embed displayed when a giveaway is running (with the remaining time)
     * @param {Giveaway} giveaway The giveaway the embed needs to be generated for
     * @param {boolean} [lastChanceEnabled=false] Whether or not to include the last chance text
     * @returns {Discord.EmbedBuilder} The generated embed
     */
    generateMainEmbed(giveaway, lastChanceEnabled = false, button = false) {
        const embed = new Discord.EmbedBuilder()
            .setTitle(typeof giveaway.messages.title === 'string' ? giveaway.messages.title : giveaway.prize)
            .setColor(
                giveaway.isDrop
                    ? giveaway.embedColor
                    : giveaway.pauseOptions.isPaused && giveaway.pauseOptions.embedColor
                    ? giveaway.pauseOptions.embedColor
                    : lastChanceEnabled
                    ? giveaway.lastChance.embedColor
                    : giveaway.embedColor
            )
            .setFooter({
                text:
                    giveaway.messages.embedFooter.text ??
                    (typeof giveaway.messages.embedFooter === 'string' ? giveaway.messages.embedFooter : ''),
                iconURL: giveaway.messages.embedFooter.iconURL
            })
            .setDescription(
                giveaway.isDrop
                    ? giveaway.messages.dropMessage
                    : (giveaway.pauseOptions.isPaused
                          ? giveaway.pauseOptions.content + '\n\n'
                          : lastChanceEnabled
                          ? giveaway.lastChance.content + '\n\n'
                          : '') +
                          giveaway.messages.inviteToParticipate +
                          '\n' +
                          giveaway.messages.drawing.replace(
                              '{timestamp-relative}',
                              giveaway.endAt === Infinity ? giveaway.pauseOptions.infiniteDurationText : `<t:${Math.round(giveaway.endAt / 1000)}:R>`
                          ).replace(
                            '{timestamp-default}',
                            giveaway.endAt === Infinity ? giveaway.pauseOptions.infiniteDurationText : `<t:${Math.round(giveaway.endAt / 1000)}>`
                          )
                          +
                          (giveaway.hostedBy ? '\n' + giveaway.messages.hostedBy : '') 
                          + 
                          (button ? '\n\n' + giveaway.messages.participants.replace('{participants}', giveaway.participants.length).replace('{member}', `${giveaway.participants.length > 0
                            ? `<@${giveaway.participants[giveaway.participants.length - 1]}>`
                            : '@Unknown'}`) : '')
            )
            .setThumbnail(giveaway.thumbnail)
            .setImage(giveaway.image)
        if (giveaway.endAt !== Infinity) embed.setTimestamp(giveaway.endAt);
        return giveaway.fillInEmbed(embed);
    }

    /**
     * Generate an embed displayed when a giveaway is ended (with the winners list)
     * @param {Giveaway} giveaway The giveaway the embed needs to be generated for
     * @param {Discord.GuildMember[]} winners The giveaway winners
     * @returns {Discord.EmbedBuilder} The generated embed
     */
    generateEndEmbed(giveaway, winners) {
        let formattedWinners = winners.map((w) => `${w}`).join(', ');

        const strings = {
            winners: giveaway.fillInString(giveaway.messages.winners),
            hostedBy: giveaway.fillInString(giveaway.messages.hostedBy),
            endedAt: giveaway.fillInString(giveaway.messages.endedAt),
            title: giveaway.fillInString(giveaway.messages.title) ?? giveaway.fillInString(giveaway.prize)
        };

        const descriptionString = (formattedWinners) =>
            strings.winners + ' ' + formattedWinners + (giveaway.hostedBy ? '\n' + strings.hostedBy : '');

        for (
            let i = 1;
            descriptionString(formattedWinners).length > 4096 ||
            strings.title.length + strings.endedAt.length + descriptionString(formattedWinners).length > 6000;
            i++
        ) {
            formattedWinners = formattedWinners.slice(0, formattedWinners.lastIndexOf(', <@')) + `, ${i} more`;
        }

        return new Discord.EmbedBuilder()
            .setTitle(strings.title)
            .setColor(giveaway.embedColorEnd)
            .setFooter({ text: strings.endedAt, iconURL: giveaway.messages.embedFooter.iconURL })
            .setDescription(descriptionString(formattedWinners))
            .setTimestamp(giveaway.endAt)
            .setThumbnail(giveaway.thumbnail)
            .setImage(giveaway.image);
    }

    /**
     * Generate an embed displayed when a giveaway is ended and when there is no valid participant
     * @param {Giveaway} giveaway The giveaway the embed needs to be generated for
     * @returns {Discord.EmbedBuilder} The generated embed
     */
    generateNoValidParticipantsEndEmbed(giveaway) {
        const embed = new Discord.EmbedBuilder()
            .setTitle(typeof giveaway.messages.title === 'string' ? giveaway.messages.title : giveaway.prize)
            .setColor(giveaway.embedColorEnd)
            .setFooter({ text: giveaway.messages.endedAt, iconURL: giveaway.messages.embedFooter.iconURL })
            .setDescription(giveaway.messages.noWinner + (giveaway.hostedBy ? '\n' + giveaway.messages.hostedBy : ''))
            .setTimestamp(giveaway.endAt)
            .setThumbnail(giveaway.thumbnail)
            .setImage(giveaway.image);
        return giveaway.fillInEmbed(embed);
    }

    /**
     * Ends a giveaway. This method is automatically called when a giveaway ends.
     * @param {Discord.Snowflake} messageId The message id of the giveaway
     * @param {?string|MessageObject} [noWinnerMessage=null] Sent in the channel if there is no valid winner for the giveaway.
     * @returns {Promise<Discord.GuildMember[]>} The winners
     *
     * @example
     * manager.end('664900661003157510');
     */
    end(messageId, noWinnerMessage = null) {
        return new Promise(async (resolve, reject) => {
            const giveaway = this.giveaways.find((g) => g.messageId === messageId);
            if (!giveaway) return reject('No giveaway found with message Id ' + messageId + '.');

            giveaway
                .end(noWinnerMessage)
                .then((winners) => {
                    this.emit('giveawayEnded', giveaway, winners);
                    resolve(winners);
                })
                .catch(reject);
        });
    }

    /**
     * Starts a new giveaway
     * @param {Discord.GuildTextBasedChannel} channel The channel in which the giveaway will be created
     * @param {GiveawayStartOptions} options The options for the giveaway
     * @returns {Promise<Giveaway>} The created giveaway.
     *
     * @example
     * manager.start(interaction.channel, {
     *      prize: 'Free Steam Key',
     *      // Giveaway will last 10 seconds
     *      duration: 10000,
     *      // One winner
     *      winnerCount: 1,
     *      // Limit the giveaway to members who have the "Nitro Boost" role
     *      exemptMembers: (member) => !member.roles.cache.some((r) => r.name === 'Nitro Boost')
     * });
     */
    start(channel, options) {
        return new Promise(async (resolve, reject) => {
            if (!this.ready) return reject('The manager is not ready yet.');
            if (!channel?.id || !channel.isTextBased()) {
                return reject(`channel is not a valid text based channel. (val=${channel})`);
            }
            if (channel.isThread() && !channel.sendable) {
                return reject(
                    `The manager is unable to send messages in the provided ThreadChannel. (id=${channel.id})`
                );
            }
            if (typeof options.prize !== 'string' || (options.prize = options.prize.trim()).length > 256) {
                return reject(`options.prize is not a string or longer than 256 characters. (val=${options.prize})`);
            }
            if (!Number.isInteger(options.winnerCount) || options.winnerCount < 1) {
                return reject(`options.winnerCount is not a positive integer. (val=${options.winnerCount})`);
            }
            if (options.isDrop && typeof options.isDrop !== 'boolean') {
                return reject(`options.isDrop is not a boolean. (val=${options.isDrop})`);
            }
            if (!options.isDrop && (!Number.isFinite(options.duration) || options.duration < 1)) {
                return reject(`options.duration is not a positive number. (val=${options.duration})`);
            }

            const giveaway = new Giveaway(this, {
                startAt: Date.now(),
                endAt: options.isDrop ? Infinity : Date.now() + options.duration,
                winnerCount: options.winnerCount,
                channelId: channel.id,
                guildId: channel.guildId,
                prize: options.prize,
                hostedBy: options.hostedBy ? options.hostedBy.toString() : undefined,
                messages: options.messages && typeof options.messages === 'object' ? deepmerge(GiveawayMessages, options.messages) : GiveawayMessages,
                thumbnail: typeof options.thumbnail === 'string' ? options.thumbnail : undefined,
                image: typeof options.image === 'string' ? options.image : undefined,
                emoji: this.options.default.buttonEmoji,
                exemptPermissions: Array.isArray(options.exemptPermissions) ? options.exemptPermissions : undefined,
                exemptMembers: typeof options.exemptMembers === 'function' ? options.exemptMembers : undefined,
                bonusEntries: Array.isArray(options.bonusEntries) && !options.isDrop ? options.bonusEntries.filter((elem) => typeof elem === 'object') : undefined,
                embedColor: validateEmbedColor(options.embedColor) ? options.embedColor : undefined,
                embedColorEnd: validateEmbedColor(options.embedColorEnd) ? options.embedColorEnd : undefined,
                extraData: options.extraData,
                lastChance: options.lastChance && typeof options.lastChance === 'object' && !options.isDrop ? options.lastChance : undefined,
                pauseOptions: options.pauseOptions && typeof options.pauseOptions === 'object' && !options.isDrop  ? options.pauseOptions  : undefined,
                allowedMentions: options.allowedMentions && typeof options.allowedMentions === 'object' ? options.allowedMentions : undefined,
                isDrop: options.isDrop
            });

            const row = new Discord.ActionRowBuilder()
            .addComponents(new Discord.ButtonBuilder()
                .setEmoji(`${this.options.default.buttonEmoji}`)
                .setStyle(typeof this.options.default.buttonStyle === 'number' ? this.options.default.buttonStyle : Discord.ButtonStyle.Secondary)
                .setCustomId(`${giveaway.isDrop ? 'vante-drop' : 'vante-enter'}`),
                           new Discord.ButtonBuilder()
                .setEmoji(`${this.options.default.button2Emoji}`)
                .setStyle(typeof this.options.default.button2Style === 'number' ? this.options.default.button2Style : Discord.ButtonStyle.Secondary)
                .setCustomId(`${giveaway.isDrop ? 'vante-drop-participants' : 'vante-enter-participants'}`),
            )

            const embed = this.generateMainEmbed(giveaway);
            var message = await channel.send({
                content: giveaway.fillInString(giveaway.messages.giveaway),
                embeds: [embed],
                components: [row],
            })

            giveaway.messageId = message.id;
            giveaway.message = message;
            this.giveaways.push(giveaway);
            await this.saveGiveaway(giveaway.messageId, giveaway.data);
            resolve(giveaway);
            if (giveaway.isDrop) {
                const collector = message.createMessageComponentCollector({
                    filter: (interaction) => interaction.customId === 'vante-drop' && interaction.user.id !== this.client.user.id && !giveaway.participants.includes(interaction.user.id),
                    max: giveaway.winnerCount,
                })

                collector.on('collect', async (interaction) => {
                    if (!giveaway.participants.includes(interaction.user.id)) {
                        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => {});
                        this.emit('giveawayJoined', giveaway, member, interaction);
                        giveaway.participants.push(interaction.user.id);
                        await this.editGiveaway(giveaway.messageId, giveaway.data, true);

                        const row = new Discord.ActionRowBuilder()
                            .addComponents(new Discord.ButtonBuilder()
                                .setEmoji(`${this.options.default.buttonEmoji}`)
                                .setLabel(`${giveaway.participants.length}`)
                                .setStyle(typeof this.options.default.buttonStyle === 'number' ? this.options.default.buttonStyle : Discord.ButtonStyle.Secondary)
                                .setCustomId('vante-drop')
                            )

                        const vante = (await giveaway.fetchMessage().catch(() => { })) ?? giveaway.message;
                        vante.edit({
                            components: [row]
                        })
                    }
                });

                collector.on('end', () => { this.end(giveaway.messageId); });
            };
        });
    }

    /**
     * Choose new winner(s) for the giveaway
     * @param {Discord.Snowflake} messageId The message Id of the giveaway to reroll
     * @param {GiveawayRerollOptions} [options] The reroll options
     * @returns {Promise<Discord.GuildMember[]>} The new winners
     *
     * @example
     * manager.reroll('664900661003157510');
     */
    reroll(messageId, options = {}) {
        return new Promise(async (resolve, reject) => {
            const giveaway = this.giveaways.find((g) => g.messageId === messageId);
            if (!giveaway) return reject('No giveaway found with message Id ' + messageId + '.');

            giveaway
                .reroll(options)
                .then((winners) => {
                    this.emit('giveawayRerolled', giveaway, winners);
                    resolve(winners);
                })
                .catch(reject);
        });
    }

    /**
     * Pauses a giveaway.
     * @param {Discord.Snowflake} messageId The message Id of the giveaway to pause.
     * @param {PauseOptions} [options=giveaway.pauseOptions] The pause options.
     * @returns {Promise<Giveaway>} The paused giveaway.
     *
     * @example
     * manager.pause('664900661003157510');
     */
    pause(messageId, options = {}) {
        return new Promise(async (resolve, reject) => {
            const giveaway = this.giveaways.find((g) => g.messageId === messageId);
            if (!giveaway) return reject('No giveaway found with message Id ' + messageId + '.');
            giveaway.pause(options).then(resolve).catch(reject);
        });
    }

    /**
     * Unpauses a giveaway.
     * @param {Discord.Snowflake} messageId The message Id of the giveaway to unpause.
     * @returns {Promise<Giveaway>} The unpaused giveaway.
     *
     * @example
     * manager.unpause('664900661003157510');
     */
    unpause(messageId) {
        return new Promise(async (resolve, reject) => {
            const giveaway = this.giveaways.find((g) => g.messageId === messageId);
            if (!giveaway) return reject('No giveaway found with message Id ' + messageId + '.');
            giveaway.unpause().then(resolve).catch(reject);
        });
    }

    /**
     * Edits a giveaway. The modifications will be applicated when the giveaway will be updated.
     * @param {Discord.Snowflake} messageId The message Id of the giveaway to edit
     * @param {GiveawayEditOptions} [options={}] The edit options
     * @returns {Promise<Giveaway>} The edited giveaway
     *
     * @example
     * manager.edit('664900661003157510', {
     *      newWinnerCount: 2,
     *      newPrize: 'Something new!',
     *      addTime: -10000 // The giveaway will end 10 seconds earlier
     * });
     */
    edit(messageId, options = {}) {
        return new Promise(async (resolve, reject) => {
            const giveaway = this.giveaways.find((g) => g.messageId === messageId);
            if (!giveaway) return reject('No giveaway found with message Id ' + messageId + '.');
            giveaway.edit(options).then(resolve).catch(reject);
        });
    }

    /**
     * Deletes a giveaway. It will delete the message and all the giveaway data.
     * @param {Discord.Snowflake} messageId  The message Id of the giveaway
     * @param {boolean} [doNotDeleteMessage=false] Whether the giveaway message shouldn't be deleted
     * @returns {Promise<Giveaway>}
     */
    delete(messageId, doNotDeleteMessage = false) {
        return new Promise(async (resolve, reject) => {
            const giveaway = this.giveaways.find((g) => g.messageId === messageId);
            if (!giveaway) return reject('No giveaway found with message Id ' + messageId + '.');

            if (!doNotDeleteMessage) {
                giveaway.message ??= await giveaway.fetchMessage().catch(() => {});
                giveaway.message?.delete();
            }
            this.giveaways = this.giveaways.filter((g) => g.messageId !== messageId);
            await this.deleteGiveaway(messageId);
            this.emit('giveawayDeleted', giveaway);
            resolve(giveaway);
        });
    }

    /**
     * Delete a giveaway from the database
     * @param {Discord.Snowflake} messageId The message Id of the giveaway to delete
     * @returns {Promise<boolean>}
     */
    async deleteGiveaway(messageId) {
        await writeFile(
            this.options.storage,
            JSON.stringify(
                this.giveaways.map((giveaway) => giveaway.data),
                (_, v) => (typeof v === 'bigint' ? serialize(v) : v)
            ),
            'utf-8'
        );
        return true;
    }

    /**
     * Gets the giveaways from the storage file, or create it
     * @ignore
     * @returns {Promise<GiveawayData[]>}
     */
    async getAllGiveaways() {
        // Whether the storage file exists, or not
        const storageExists = await access(this.options.storage)
            .then(() => true)
            .catch(() => false);

        // If it doesn't exists
        if (!storageExists) {
            // Create the file with an empty array
            await writeFile(this.options.storage, '[]', 'utf-8');
            return [];
        } else {
            // If the file exists, read it
            const storageContent = await readFile(this.options.storage, { encoding: 'utf-8' });
            if (!storageContent.trim().startsWith('[') || !storageContent.trim().endsWith(']')) {
                console.log(storageContent);
                throw new SyntaxError('The storage file is not properly formatted (does not contain an array).');
            }

            try {
                return await JSON.parse(storageContent, (_, v) =>
                    typeof v === 'string' && /BigInt\("(-?\d+)"\)/.test(v) ? eval(v) : v
                );
            } catch (err) {
                if (err.message.startsWith('Unexpected token')) {
                    throw new SyntaxError(
                        `${err.message} | LINK: (${require('path').resolve(this.options.storage)}:1:${err.message
                            .split(' ')
                            .at(-1)})`
                    );
                }
                throw err;
            }
        }
    }

    /**
     * Edit the giveaway in the database
     * @ignore
     * @param {Discord.Snowflake} messageId The message Id identifying the giveaway
     * @param {GiveawayData} giveawayData The giveaway data to save
     */
    async editGiveaway(messageId, giveawayData, message = false) {
        await writeFile(
            this.options.storage,
            JSON.stringify(
                this.giveaways.map((giveaway) => giveaway.data),
                (_, v) => (typeof v === 'bigint' ? serialize(v) : v)
            ),
            'utf-8'
        );

        if (message) {
            this.gi
        }
        return;
    }

    /**
     * Save the giveaway in the database
     * @ignore
     * @param {Discord.Snowflake} messageId The message Id identifying the giveaway
     * @param {GiveawayData} giveawayData The giveaway data to save
     */
    async saveGiveaway(messageId, giveawayData) {
        await writeFile(
            this.options.storage,
            JSON.stringify(
                this.giveaways.map((giveaway) => giveaway.data),
                (_, v) => (typeof v === 'bigint' ? serialize(v) : v)
            ),
            'utf-8'
        );
        return;
    }

    /**
     * Checks each giveaway and update it if needed
     * @ignore
     */
    _checkGiveaway() {
        if (this.giveaways.length <= 0) return;
        this.giveaways.forEach(async (giveaway) => {
            if (giveaway.ended) {
                if (
                    Number.isFinite(this.options.endedGiveawaysLifetime) &&
                    giveaway.endAt + this.options.endedGiveawaysLifetime <= Date.now()
                ) {
                    this.giveaways = this.giveaways.filter((g) => g.messageId !== giveaway.messageId);
                    await this.deleteGiveaway(giveaway.messageId);
                }
                return;
            }

            // Third case: the giveaway is paused and we should check whether it should be unpaused
            if (giveaway.pauseOptions.isPaused) {
                if (
                    !Number.isFinite(giveaway.pauseOptions.unpauseAfter) &&
                    !Number.isFinite(giveaway.pauseOptions.durationAfterPause)
                ) {
                    giveaway.options.pauseOptions.durationAfterPause = giveaway.remainingTime;
                    giveaway.endAt = Infinity;
                    await this.editGiveaway(giveaway.messageId, giveaway.data);
                }
                if (
                    Number.isFinite(giveaway.pauseOptions.unpauseAfter) &&
                    Date.now() > giveaway.pauseOptions.unpauseAfter
                ) {
                    return this.unpause(giveaway.messageId).catch(() => {});
                }
            }

            // Fourth case: giveaway should be ended right now. this case should only happen after a restart
            // Because otherwise, the giveaway would have been ended already (using the next case)
            if (giveaway.remainingTime <= 0) return this.end(giveaway.messageId).catch(() => {});

            // Fifth case: the giveaway will be ended soon, we add a timeout so it ends at the right time
            // And it does not need to wait for _checkGiveaway to be called again
            giveaway.ensureEndTimeout();

            // Sixth case: the giveaway will be in the last chance state soon, we add a timeout so it's updated at the right time
            // And it does not need to wait for _checkGiveaway to be called again
            if (
                giveaway.lastChance.enabled &&
                giveaway.remainingTime - giveaway.lastChance.threshold <
                    (this.options.forceUpdateEvery || DEFAULT_CHECK_INTERVAL)
            ) {
                setTimeout(async () => {
                    giveaway.message ??= await giveaway.fetchMessage().catch(() => {});
                    const embed = this.generateMainEmbed(giveaway, true, giveaway.participants.length > 0);
                    await giveaway.message
                        ?.edit({
                            content: giveaway.fillInString(giveaway.messages.giveaway),
                            embeds: [embed],
                            allowedMentions: giveaway.allowedMentions
                        })
                        .catch(() => {});
                }, giveaway.remainingTime - giveaway.lastChance.threshold);
            }

            // Fetch the message if necessary and make sure the embed is alright
            giveaway.message ??= await giveaway.fetchMessage().catch(() => {});
            if (!giveaway.message) return;
            if (!giveaway.message.embeds[0]) await giveaway.message.suppressEmbeds(false).catch(() => {});

            // Regular case: the giveaway is not ended and we need to update it
            const lastChanceEnabled =
                giveaway.lastChance.enabled && giveaway.remainingTime < giveaway.lastChance.threshold;
            const updatedEmbed = this.generateMainEmbed(giveaway, lastChanceEnabled, giveaway.participants.length > 0);
            const needUpdate =
                !embedEqual(giveaway.message.embeds[0].data, updatedEmbed.data) ||
                giveaway.message.content !== giveaway.fillInString(giveaway.messages.giveaway);

            if (needUpdate || this.options.forceUpdateEvery) {
                await giveaway.message
                    .edit({
                        content: giveaway.fillInString(giveaway.messages.giveaway),
                        embeds: [updatedEmbed],
                        allowedMentions: giveaway.allowedMentions
                    })
                    .catch(() => {});
            }
        });
    }


    /**
     * @ignore
     * @param {any} packet
     */
    async _handleRawPacket(packet) {
        if (!packet.isButton()) return;
        if (packet.user.id === this.client.user.id) return;
        if (packet.customId !== 'vante-enter') return
        let giveaway = this.giveaways.find((g) => g.messageId === packet.message?.id);
        if (!giveaway || (giveaway.ended)) return;

        const guild = this.client.guilds.cache.get(packet.guild?.id) || (await this.client.guilds.fetch(packet.guild?.id).catch(() => {}));
        if (!guild || !guild.available) return;

        const member = await guild.members.fetch(packet.user.id).catch(() => {});
        if (!member) return;

        const channel = await this.client.channels.fetch(packet.channel?.id).catch(() => {});
        if (!channel) return;

        const message = await channel.messages.fetch(packet.message?.id).catch(() => {});
        if (!message) return;

        if (!giveaway.participants.includes(packet.user.id)) {
            this.emit('giveawayJoined', giveaway, member, packet);
            giveaway.participants.push(packet.user.id);
            await this.editGiveaway(giveaway.messageId, giveaway.data, true);

            const row = new Discord.ActionRowBuilder()
            .addComponents(new Discord.ButtonBuilder()
                .setEmoji(`${this.options.default.buttonEmoji}`)
                .setLabel(`${giveaway.participants.length}`)
                .setStyle(typeof this.options.default.buttonStyle === 'number' ? this.options.default.buttonStyle : Discord.ButtonStyle.Secondary)
                .setCustomId('vante-enter')
            )

            const lastChanceEnabled =
                giveaway.lastChance.enabled && giveaway.remainingTime < giveaway.lastChance.threshold;
            const buttonClickedEnabled = giveaway.participants.length > 0

            const embed = this.generateMainEmbed(giveaway, lastChanceEnabled, buttonClickedEnabled);

            const vante = (await giveaway.fetchMessage().catch(() => {})) ?? giveaway.message;
            vante.edit({
                embeds: [embed],
                components: [row]
            })
        } else {
            this.emit('giveawayLeaved', giveaway, member, packet);
            giveaway.participants.splice(giveaway.participants.indexOf(packet.user.id), 1);
            await this.editGiveaway(giveaway.messageId, giveaway.data, true);

            const row = new Discord.ActionRowBuilder()
            .addComponents(new Discord.ButtonBuilder()
                .setEmoji(`${this.options.default.buttonEmoji}`)
                .setLabel(`${giveaway.participants.length == 0 ? ' ' : giveaway.participants.length}`)
                .setStyle(typeof this.options.default.buttonStyle === 'number' ? this.options.default.buttonStyle : Discord.ButtonStyle.Secondary)
                .setCustomId('vante-enter')
            )

            const lastChanceEnabled =
                giveaway.lastChance.enabled && giveaway.remainingTime < giveaway.lastChance.threshold;
            const buttonClickedEnabled = giveaway.participants.length > 0

            const embed = this.generateMainEmbed(giveaway, lastChanceEnabled ?? false, buttonClickedEnabled);

            const vante = (await giveaway.fetchMessage().catch(() => {})) ?? giveaway.message;
            vante.edit({
                embeds: [embed],
                components: [row]
            })
        }
    }

    /**
     * Inits the manager
     * @ignore
     */
    async _init() {
        let rawGiveaways = await this.getAllGiveaways();

        await (this.client.readyAt ? Promise.resolve() : new Promise((resolve) => this.client.once('ready', resolve)));

        // Filter giveaways for each shard
        if (this.client.shard && this.client.guilds.cache.size) {
            const shardId = Discord.ShardClientUtil.shardIdForGuildId(
                this.client.guilds.cache.first().id,
                this.client.shard.count
            );
            rawGiveaways = rawGiveaways.filter(
                (g) => shardId === Discord.ShardClientUtil.shardIdForGuildId(g.guildId, this.client.shard.count)
            );
        }

        rawGiveaways.forEach((giveaway) => this.giveaways.push(new Giveaway(this, giveaway)));

        setInterval(() => {
            if (this.client.readyAt) this._checkGiveaway.call(this);
        }, this.options.forceUpdateEvery || DEFAULT_CHECK_INTERVAL);
        this.ready = true;

        // Delete data of ended giveaways
        if (Number.isFinite(this.options.endedGiveawaysLifetime)) {
            const endedGiveaways = this.giveaways.filter(
                (g) => g.ended && g.endAt + this.options.endedGiveawaysLifetime <= Date.now()
            );
            this.giveaways = this.giveaways.filter(
                (g) => !endedGiveaways.map((giveaway) => giveaway.messageId).includes(g.messageId)
            );
            for (const giveaway of endedGiveaways) await this.deleteGiveaway(giveaway.messageId);
        }

        this.client.on('interactionCreate', (packet) => this._handleRawPacket(packet));
    }
}

/**
 * Emitted when a giveaway ended.
 * @event GiveawaysManager#giveawayEnded
 * @param {Giveaway} giveaway The giveaway instance
 * @param {Discord.GuildMember[]} winners The giveaway winners
 *
 * @example
 * // This can be used to add features such as a congratulatory message in DM
 * manager.on('giveawayEnded', (giveaway, winners) => {
 *      winners.forEach((member) => {
 *          member.send('Congratulations, ' + member.user.username + ', you won: ' + giveaway.prize);
 *      });
 * });
 */

/**
 * Emitted when someone entered a giveaway.
 * @event GiveawaysManager#giveawayJoined
 * @param {Giveaway} giveaway The giveaway instance
 * @param {Discord.GuildMember} member The member who entered the giveaway
 * @param {Discord.Interaction} interaction The interaction that gets triggered when clicked the button
 *
 * @example
 * // This can be used to add features such as removing reactions of members when they do not have a specific role (= giveaway requirements)
 * // Best used with the "exemptMembers" property of the giveaways
 * manager.on('giveawayJoined', (giveaway, member, interaction) => {
 *   if (!giveaway.isDrop) return interaction.reply({ content: `:tada: Congratulations **${member.user.username}**, you have joined the giveaway`, ephemeral: true })
 * 
 *   interaction.reply({ content: `:tada: Congratulations **${member.user.username}**, you have joined the drop giveaway`, ephemeral: true })
 * });
 */

/**
 * Emitted when someone leaved a giveaway.
 * @event GiveawaysManager#giveawayReactionRemoved
 * @param {Giveaway} giveaway The giveaway instance
 * @param {Discord.GuildMember} member The member who remove their reaction giveaway
 * @param {Discord.Interaction} interaction The interaction that gets triggered when clicked the button
 *
 * @example
 * // This can be used to add features such as a member-left-giveaway message per DM
 * manager.on('giveawayLeaved', (giveaway, member, interaction) => {
 *   interaction.reply({ content: `**${member.user.username}**, you have left the drop giveaway`, ephemeral: true })
 * });
 */

/**
 * Emitted when a giveaway was rerolled.
 * @event GiveawaysManager#giveawayRerolled
 * @param {Giveaway} giveaway The giveaway instance
 * @param {Discord.GuildMember[]} winners The winners of the giveaway
 *
 * @example
 * // This can be used to add features such as a congratulatory message per DM
 * manager.on('giveawayRerolled', (giveaway, winners) => {
 *      winners.forEach((member) => {
 *          member.send('Congratulations, ' + member.user.username + ', you won: ' + giveaway.prize);
 *      });
 * });
 */

/**
 * Emitted when a giveaway was deleted.
 * @event GiveawaysManager#giveawayDeleted
 * @param {Giveaway} giveaway The giveaway instance
 *
 * @example
 * // This can be used to add logs
 * manager.on('giveawayDeleted', (giveaway) => {
 *      console.log('Giveaway with message Id ' + giveaway.messageId + ' was deleted.')
 * });
 */

module.exports = GiveawaysManager;
