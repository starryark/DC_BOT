# `discord-bot`

Allow アイリ to talk to you and many other users in Discord voice channels.

## Getting started

```shell
git clone git@github.com:moeru-ai/airi.git
pnpm i
```

In [Discord Developer Portal](https://discord.com/developers/home), create a new application and this will be the bot
you will add to your server.

In the **"Bot"** tab, find "Privileged Gateway Intents" section, toggle on the following intents:

- **"Server Members Intent"**
- **"Message Content Intent"**

Now look above the "Privileged Gateway Intents" section, you will find the "Token" section,
for newly created bots, click "Reset Token" to generate a new token, and copy the token for later use.

> [!NOTE]
> If you ever forgot the token or lost it, you can always click "Reset Token" to generate a new token,
> but remember to update the token in your `.env.local` file, or configure through the UI as well.

Create a `.env.local` file:

```shell
cd services/discord-bot
cp .env .env.local
```

Fill-in the following credentials as configurations:

```shell
DISCORD_TOKEN=''
DISCORD_BOT_CLIENT_ID=''

OPENAI_MODEL=''
OPENAI_API_KEY=''
OPENAI_API_BASE_URL=''

ELEVENLABS_API_KEY=''
ELEVENLABS_API_BASE_URL=''
```

```shell
pnpm run -F @proj-airi/discord-bot start
```

## Other similar projects

- [pladisdev/Discord-AI-With-STT](https://github.com/pladisdev/Discord-AI-With-STT)

## Acknowledgements

- Implementation of Audio handling and processing https://github.com/TheTrueSCP/CharacterAIVoice/blob/54d6a41b4e0eba9ad996c5f9ddcc6230277af2f8/src/VoiceHandler.js
- Example of usage https://github.com/discordjs/voice-examples/blob/da0c3b419107d41053501a4dddf3826ad53c03f7/radio-bot/src/bot.ts
- Excellent library https://github.com/discordjs/discord.js
# Multilingual routing and pronunciation check

After starting the local ASR, Gemini, GPT-SoVITS, and Discord bot services, test these voice turns in a fresh guild session: `christina`, `你是makise是吗`, `makiseって誰？`, and `Are you Makise?`. Confirm the reply languages are Japanese, Chinese, Japanese, and English respectively, and inspect `input_understanding_resolved` without enabling transcript logging.

For pronunciation changes, add candidate `speechText` values to a local copy of the character interaction profile and synthesize the same short sentence at least three times per candidate through the existing `/voice-test` command. Listen for name intelligibility, natural rhythm, and voice consistency. Record the winning value only after testing it on the deployed Kurisu checkpoint; do not commit generated audio or claim an untested English romanization is validated. Increment `pronunciationProfileVersion` whenever the effective pronunciation rules change so cached audio is not reused.
