// index.js
const express = require('express');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const fetch = require('node-fetch');
require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'gpt-4o-mini';
const GUILD_ID = process.env.GUILD_ID;
const PORT = process.env.PORT || 3000; // 👈 for Render

if (!DISCORD_TOKEN || !OPENROUTER_API_KEY) {
  console.error('Missing DISCORD_TOKEN or OPENROUTER_API_KEY in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- Minimal Express web server for Render health checks ---
const app = express();
app.get('/', (req, res) => res.send('🤖 Discord bot is running.'));
app.listen(PORT, () => console.log(`✅ Web server listening on port ${PORT}`));
// ------------------------------------------------------------

async function registerCommand() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const command = new SlashCommandBuilder()
    .setName('createchannels')
    .setDescription('Create Discord channels from a natural language prompt.')
    .addStringOption(opt =>
      opt.setName('prompt').setDescription('Describe the channels to create').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('dryrun').setDescription('Set 1 for preview, 0 to actually create')
    )
    .toJSON();

  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [command] });
      console.log('Registered guild command');
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: [command] });
      console.log('Registered global command');
    }
  } catch (err) {
    console.error('Command registration failed:', err);
  }
}

async function callOpenRouter(prompt) {
  const response = await fetch('https://api.openrouter.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: 'Return a valid JSON array of channels with name/type/topic/parent.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 800,
    }),
  });

  const data = await response.json();
  return data?.choices?.[0]?.message?.content;
}

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommand();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'createchannels') return;

  await interaction.deferReply();
  const prompt = interaction.options.getString('prompt');
  const dryrun = !!interaction.options.getInteger('dryrun');

  try {
    const result = await callOpenRouter(prompt);
    const jsonMatch = result.match(/\[.*\]/s);
    const jsonText = jsonMatch ? jsonMatch[0] : result;
    const channels = JSON.parse(jsonText);

    if (dryrun) {
      const preview = channels.map(c => `- ${c.type}: ${c.name}${c.parent ? ` (in ${c.parent})` : ''}`).join('\n');
      await interaction.editReply(`**Dry Run Preview:**\n${preview}`);
      return;
    }

    for (const ch of channels) {
      if (ch.type === 'category') {
        await interaction.guild.channels.create({ name: ch.name, type: ChannelType.GuildCategory });
      } else if (ch.type === 'voice') {
        await interaction.guild.channels.create({ name: ch.name, type: ChannelType.GuildVoice });
      } else {
        await interaction.guild.channels.create({ name: ch.name, type: ChannelType.GuildText, topic: ch.topic || null });
      }
    }

    await interaction.editReply('✅ Channels created successfully.');
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Error: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);
