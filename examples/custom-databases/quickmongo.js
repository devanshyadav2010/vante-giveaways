const Discord = require('discord.js');
const client = new Discord.Client({
    intents: [Discord.IntentsBitField.Flags.Guilds, Discord.IntentsBitField.Flags.GuildMembers]
});

// Load quickmongo
const { Database } = require('quickmongo');
const giveawayDB = new Database('mongodb://localhost/database', { collectionName: 'giveaways' });

// Start the manager only after the DB turned ready to prevent an error
giveawayDB.once('ready', () => client.giveawaysManager._init());

const { GiveawaysManager } = require('discord-giveaways');
const GiveawayManagerWithOwnDatabase = class extends GiveawaysManager {
    // This function is called when the manager needs to get all giveaways which are stored in the database.
    async getAllGiveaways() {
        // Get all giveaways from the database
        return (await giveawayDB.all()).map((element) => element.data);
    }

    // This function is called when a giveaway needs to be saved in the database.
    async saveGiveaway(messageId, giveawayData) {
        // Add the new giveaway to the database
        await giveawayDB.set(messageId, giveawayData);
        // Don't forget to return something!
        return true;
    }

    // This function is called when a giveaway needs to be edited in the database.
    async editGiveaway(messageId, giveawayData) {
        // Replace the unedited giveaway with the edited giveaway
        await giveawayDB.set(messageId, giveawayData);
        // Don't forget to return something!
        return true;
    }

    // This function is called when a giveaway needs to be deleted from the database.
    async deleteGiveaway(messageId) {
        // Remove the giveaway from the database
        await giveawayDB.delete(messageId);
        // Don't forget to return something!
        return true;
    }
};

// Create a new instance of your new class
const manager = new GiveawayManagerWithOwnDatabase(client, {
    default: {
        buttonEmoji: '🎉',
        buttonStyle: Discord.ButtonStyle.Secondary,
        embedColor: '#FF0000',
        embedColorEnd: '#000000',
    }
});
// We now have a giveawaysManager property to access the manager everywhere!
client.giveawaysManager = manager;

client.giveawaysManager.on('giveawayJoined', (giveaway, member, interaction) => {
    if (!giveaway.isDrop) return interaction.reply({ content: `:tada: Congratulations **${member.user.username}**, you have joined the giveaway`, ephemeral: true })
  
    interaction.reply({ content: `:tada: Congratulations **${member.user.username}**, you have joined the drop giveaway`, ephemeral: true })
});
  
client.giveawaysManager.on('giveawayLeaved', (giveaway, member, interaction) => {
    if (!giveaway.isDrop) return interaction.reply({ content: `**${member.user.username}**, you have left the giveaway`, ephemeral: true })
  
    interaction.reply({ content: `**${member.user.username}**, you have left the drop giveaway`, ephemeral: true })
});

client.on('ready', () => {
    console.log('Bot is ready!');
});

client.login(process.env.DISCORD_BOT_TOKEN);