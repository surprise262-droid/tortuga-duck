import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { baseEmbed, respond } from '../util';

export const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Что умеет Tortuga Duck'),
  new SlashCommandBuilder().setName('ping').setDescription('Проверить, жив ли бот'),
];

export async function onCommand(i: ChatInputCommandInteraction) {
  if (i.commandName === 'ping') {
    return respond(i, `🦆 Кря! Задержка: ${Math.round(i.client.ws.ping)} мс`);
  }

  const embed = baseEmbed()
    .setTitle('🦆 Tortuga Duck — что я умею')
    .setDescription('Бармен, диджей и швейцар в одном клюве.')
    .addFields(
      {
        name: '🎵 Музыка',
        value: [
          '`/play` — трек или плейлист: SoundCloud, ссылка Spotify, MP3-файл, радио',
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
        value: '`/setup` — каналы и роли бота, DJ-режим. `/welcome-test`, `/news-now`.',
      },
    );
  return respond(i, { embeds: [embed] });
}
