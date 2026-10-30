import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { allSettings, getSetting, setSetting } from '../db';
import { baseEmbed, respond } from '../util';
import { resetAnimeAnnounce, runAnimeNow } from './anime';
import { resetCategory, runNewsNow } from './news';
import { postControlPanel } from './privateVoice';
import { postRolesPanel } from './roles';

/** Назначения каналов: [ключ, подпись, нужен голосовой?] */
export const CHANNEL_PURPOSES: [string, string, boolean][] = [
  ['welcome', 'Приветствия новичков', false],
  ['roles', 'Выбор ролей (панель)', false],
  ['vc_lobby', 'Join to Create (голосовой)', true],
  ['vc_control', 'Управление приватными каналами (панель)', false],
  ['music', 'Плеер музыки', false],
  ['news_games', 'Новости: игры', false],
  ['news_movies', 'Новости: кино и сериалы', false],
  ['news_anime', 'Новости: аниме', false],
  ['news_free', 'Новости: халява', false],
  ['anime_announce', 'Аниме: анонсы и календарь', false],
];

const ROLE_PURPOSES: [string, string][] = [
  ['base', 'Базовая роль (выдаётся всем при входе)'],
  ['dj', 'DJ (управление музыкой в DJ-режиме)'],
];

export const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Настройка бота (для админов)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('channel')
        .setDescription('Назначить канал для функции бота')
        .addStringOption((o) =>
          o
            .setName('purpose')
            .setDescription('Для чего канал')
            .setRequired(true)
            .addChoices(...CHANNEL_PURPOSES.map(([value, name]) => ({ name, value }))),
        )
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Канал')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('role')
        .setDescription('Назначить роль для функции бота')
        .addStringOption((o) =>
          o
            .setName('purpose')
            .setDescription('Для чего роль')
            .setRequired(true)
            .addChoices(...ROLE_PURPOSES.map(([value, name]) => ({ name, value }))),
        )
        .addRoleOption((o) => o.setName('role').setDescription('Роль').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('djmode')
        .setDescription('Включить или выключить DJ-режим')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Включён?').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('radio_deezer')
        .setDescription('Радио: подбирать через Deezer автоматически, если Spotify не смог')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Включено? (по умолчанию — нет, только кнопкой)').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Показать текущие настройки')),
];

export async function onCommand(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();

  if (sub === 'channel') {
    const purpose = i.options.getString('purpose', true);
    const channel = i.options.getChannel('channel', true);
    const needsVoice = CHANNEL_PURPOSES.find(([k]) => k === purpose)?.[2];
    const isVoice = channel.type === ChannelType.GuildVoice;
    if (needsVoice && !isVoice) return respond(i, '❌ Для Join to Create нужен **голосовой** канал.');
    if (!needsVoice && isVoice) return respond(i, '❌ Для этой функции нужен **текстовый** канал.');

    const previous = getSetting(`channel.${purpose}`);
    setSetting(`channel.${purpose}`, channel.id);
    let extra = '';
    if (purpose.startsWith('news_') && previous !== channel.id) {
      // Новый канал получает свежую новость от каждого источника сразу, а не ждёт новых статей
      resetCategory(purpose.slice('news_'.length));
      void runNewsNow(i.client);
      extra = '\nСейчас опубликую в него по одной свежей новости от каждого источника.';
    }
    if (purpose === 'anime_announce' && previous !== channel.id) {
      resetAnimeAnnounce();
      void runAnimeNow(i.client);
      extra = '\nСейчас создам и закреплю в нём календарь анонсов. Новые анонсы будут приходить сюда же.';
    }
    if (purpose === 'vc_control' && i.guild) {
      await postControlPanel(i.guild, channel.id);
      extra = '\nПанель управления приватками отправлена в канал.';
    }
    if (purpose === 'roles' && i.guild) {
      await postRolesPanel(i.guild, channel.id);
      extra = '\nПанель выбора ролей отправлена в канал.';
    }
    return respond(i, `✅ Канал <#${channel.id}> назначен.${extra}`);
  }

  if (sub === 'role') {
    const purpose = i.options.getString('purpose', true);
    const role = i.options.getRole('role', true);
    setSetting(`role.${purpose}`, role.id);
    return respond(i, `✅ Роль <@&${role.id}> назначена.`);
  }

  if (sub === 'djmode') {
    const enabled = i.options.getBoolean('enabled', true);
    setSetting('dj_mode', enabled ? '1' : '0');
    return respond(
      i,
      enabled
        ? '🎧 DJ-режим **включён**: управлять музыкой могут только DJ и админы (пропустить свой трек может и тот, кто его поставил).'
        : '🎧 DJ-режим **выключен**: управлять музыкой может любой, кто сидит в голосовом с ботом.',
    );
  }

  if (sub === 'radio_deezer') {
    const enabled = i.options.getBoolean('enabled', true);
    setSetting('radio_deezer', enabled ? '1' : '0');
    return respond(
      i,
      enabled
        ? '📻 Если Spotify не подберёт похожие, радио **само** возьмёт подборку Deezer.'
        : '📻 Радио подбирает **только через Spotify**. Если он не справится, бот предложит Deezer кнопкой.',
    );
  }

  // show
  const s = allSettings();
  const lines = [
    ...CHANNEL_PURPOSES.map(([k, label]) => `${label}: ${s[`channel.${k}`] ? `<#${s[`channel.${k}`]}>` : '—'}`),
    ...ROLE_PURPOSES.map(([k, label]) => `${label}: ${s[`role.${k}`] ? `<@&${s[`role.${k}`]}>` : '—'}`),
    `DJ-режим: ${s['dj_mode'] === '1' ? 'включён' : 'выключен'}`,
    `Радио, запасной Deezer: ${s['radio_deezer'] === '1' ? 'автоматически' : 'только кнопкой'}`,
  ];
  return respond(i, { embeds: [baseEmbed().setTitle('⚙️ Настройки Tortuga Duck').setDescription(lines.join('\n'))] });
}
