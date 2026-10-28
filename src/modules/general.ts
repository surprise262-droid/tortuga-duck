import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { baseEmbed, respond } from '../util';

export const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Что умеет Tortuga Duck'),
  new SlashCommandBuilder().setName('ping').setDescription('Проверить, жив ли бот'),
  new SlashCommandBuilder()
    .setName('clear_messages')
    .setDescription('Удалить последние сообщения в этом канале (только владелец сервера)')
    // Команду видят только администраторы, а выполнить может только владелец сервера
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption((o) =>
      o.setName('amount').setDescription('Сколько сообщений удалить (1–100)').setRequired(true).setMinValue(1).setMaxValue(100),
    ),
];

export async function onCommand(i: ChatInputCommandInteraction) {
  if (i.commandName === 'ping') {
    return respond(i, `🦆 Кря! Задержка: ${Math.round(i.client.ws.ping)} мс`);
  }
  if (i.commandName === 'clear_messages') return clearMessages(i);

  const embed = baseEmbed()
    .setTitle('🦆 Tortuga Duck — что я умею')
    .setDescription('Бармен, диджей и швейцар в одном клюве.')
    .addFields(
      {
        name: '🎵 Музыка',
        value: [
          '`/play` — начни вводить название, бот покажет варианты; можно и ссылку: SoundCloud, Spotify, Bandcamp, радио',
          '`/play_file` — включить свой аудиофайл (MP3, OGG, WAV, M4A, FLAC)',
          '`/skip` `/pause` `/resume` `/stop` — управление (только из голосового канала)',
          '`/volume` — громкость, `/shuffle` — перемешивание, `/loop` — повтор',
          '`/queue` — очередь, `/remove` — убрать трек, `/nowplaying` — показать плеер',
        ].join('\n'),
      },
      {
        name: '🔊 Приватные каналы',
        value: 'Зайди в голосовой канал «Создать канал» — бот создаст твой личный. Настройки — кнопками в канале управления: название, лимит, закрыть/открыть, пустить/выгнать, передать владение. Пустой канал удаляется сам.',
      },
      {
        name: '🎭 Роли',
        value: '`/roles` — выбрать, какие новости и каналы тебе показывать.',
      },
      {
        name: '🛠 Для админов',
        value: '`/setup` — каналы и роли бота, DJ-режим. `/welcome-test`, `/news-now`, `/clear_messages`.',
      },
    );
  return respond(i, { embeds: [embed] });
}

async function clearMessages(i: ChatInputCommandInteraction) {
  if (!i.inCachedGuild()) return;
  if (i.user.id !== i.guild.ownerId) {
    return respond(i, '🔒 Эта команда доступна только владельцу сервера.');
  }
  const channel = i.channel;
  if (!channel || !('bulkDelete' in channel)) {
    return respond(i, '❌ В этом канале нельзя удалять сообщения пачкой.');
  }

  const amount = i.options.getInteger('amount', true);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    // true — пропускать сообщения старше 14 дней (Discord не даёт удалять их пачкой)
    const deleted = await channel.bulkDelete(amount, true);
    const skipped = amount - deleted.size;
    return i.editReply(
      `🧹 Удалено сообщений: **${deleted.size}**.` +
        (skipped > 0 ? `\nОстальные старше 14 дней или их меньше — Discord не позволяет удалять такие пачкой.` : ''),
    );
  } catch (e: any) {
    if (e?.code === 50013) {
      return i.editReply('⚠️ У бота нет права **«Управлять сообщениями»**. Включи его роли Tortuga Duck в настройках сервера → Роли.');
    }
    console.warn('[clear] Ошибка:', e?.message ?? e);
    return i.editReply(`⚠️ Не получилось удалить: ${e?.message ?? 'неизвестная ошибка'}`);
  }
}
