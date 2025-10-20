// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const express = require('express');
const axios = require('axios');

// ------------------- Express Server for Render -------------------
const app = express();
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(process.env.PORT || 3000, () => console.log('✅ Express server running'));

// ------------------- Environment Variables -------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Required for global commands
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!DISCORD_TOKEN || !CLIENT_ID || !OPENROUTER_API_KEY) {
  console.error('❌ Missing DISCORD_TOKEN, CLIENT_ID, or OPENROUTER_API_KEY');
  process.exit(1);
}

// ------------------- Discord Client -------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ------------------- Slash Command Setup -------------------
const commands = [
  new SlashCommandBuilder()
    .setName('createchannels')
    .setDescription('Create Discord channels from a natural-language prompt')
    .addStringOption(opt => opt.setName('prompt').setDescription('Describe the channels').setRequired(true))
    .addIntegerOption(opt => opt.setName('dryrun').setDescription('1 = preview only, 0 = create').setRequired(false))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Global commands registered (may take up to 1 hour to appear)');
  } catch (err) {
    console.error('❌ Failed to register global commands:', err);
  }
})();

// ------------------- OpenRouter AI Call -------------------
async function callOpenRouter(prompt) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Return ONLY a JSON array of Discord channels with name/type/topic/parent.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 500
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return res.data.choices[0]?.message?.content || '⚠️ No response';
    } catch (err) {
      console.warn(`OpenRouter attempt ${i + 1} failed:`, err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('OpenRouter API unreachable after 3 attempts');
}

// ------------------- Helpers -------------------
function sanitizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 100);
}

// ------------------- Message @Mention AI -------------------
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.mentions.has(client.user)) {
    const prompt = message.content.replace(/<@!?\d+>/, '').trim();
    if (!prompt) return message.reply('❌ You must say something.');
    try {
      const reply = await callOpenRouter(prompt);
      message.reply(reply);
    } catch (err) {
      console.error('❌ AI Error:', err);
      message.reply('❌ OpenRouter API is unavailable.');
    }
  }
});

// ------------------- Slash Command Handling -------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'createchannels') return;

  await interaction.deferReply();
  const prompt = interaction.options.getString('prompt');
  const dryrun = !!interaction.options.getInteger('dryrun');

  try {
    const modelOutput = await callOpenRouter(prompt);

    // Extract JSON array
    const jsonMatch = modelOutput.match(/\[.*\]/s);
    const jsonText = jsonMatch ? jsonMatch[0] : modelOutput;
    let channels = JSON.parse(jsonText);

    channels = channels.map((c, idx) => ({
      name: sanitizeName(c.name || `channel-${idx + 1}`),
      type: c.type === 'voice' ? 'voice' : c.type === 'category' ? 'category' : 'text',
      topic: c.topic || null,
      parent: c.parent || null
    }));

    if (dryrun) {
      const preview = channels.map(c => `- ${c.type.toUpperCase()}: ${c.name}${c.parent ? ` (parent: ${c.parent})` : ''}`).join('\n');
      return interaction.editReply(`**Preview (dry run)**\n${preview}`);
    }

    // Create categories first
    const categoryMap = {};
    for (const ch of channels) {
      if (ch.type === 'category') {
        const created = await interaction.guild.channels.create({ name: ch.name, type: ChannelType.GuildCategory });
        categoryMap[ch.name] = created.id;
      }
    }

    const createdChannels = [];
    for (const ch of channels) {
      if (ch.type === 'category') continue;
      const options = {
        name: ch.name,
        type: ch.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        topic: ch.topic,
        parent: ch.parent ? categoryMap[ch.parent] : undefined
      };
      try {
        const created = await interaction.guild.channels.create(options);
        createdChannels.push({ name: created.name, type: ch.type });
      } catch (err) {
        createdChannels.push({ name: ch.name, error: err.message });
      }
    }

    const resultLines = createdChannels.map(c => c.error ? `⚠️ ${c.name} — ${c.error}` : `✅ ${c.type} ${c.name}`).join('\n');
    interaction.editReply(`**Channels Created**\n${resultLines}`);
  } catch (err) {
    console.error('❌ Command Error:', err);
    interaction.editReply(`❌ Failed: ${err.message}`);
  }
});

// ------------------- Bot Ready -------------------
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);
