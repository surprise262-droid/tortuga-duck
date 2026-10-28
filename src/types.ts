import type {
  ChatInputCommandInteraction,
  Client,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from 'discord.js';

export type ComponentInteraction = MessageComponentInteraction | ModalSubmitInteraction;

export interface BotModule {
  /** Слэш-команды модуля */
  commands?: { name: string; toJSON(): unknown }[];
  /** Префикс customId кнопок/меню/модалок модуля, например "music" → "music:skip" */
  componentPrefix?: string;
  onCommand?(i: ChatInputCommandInteraction): Promise<unknown>;
  onComponent?(i: ComponentInteraction): Promise<unknown>;
  /** Вызывается один раз до входа бота: подписка на события, таймеры */
  setup?(client: Client): void;
}
