function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Не задана переменная окружения ${name}. Проверь файл .env`);
    process.exit(1);
  }
  return value;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  lavalink: {
    host: process.env.LAVALINK_HOST ?? 'lavalink',
    port: Number(process.env.LAVALINK_PORT ?? 2333),
    password: process.env.LAVALINK_PASSWORD ?? 'youshallnotpass',
  },
  dataDir: process.env.DATA_DIR ?? './data',
  configDir: process.env.CONFIG_DIR ?? './config',
  assetsDir: process.env.ASSETS_DIR ?? './assets',
  defaultVolume: Number(process.env.DEFAULT_VOLUME ?? 50),
  privateVcIdleMinutes: Number(process.env.PRIVATE_VC_IDLE_MINUTES ?? 15),
  newsIntervalMinutes: Number(process.env.NEWS_INTERVAL_MINUTES ?? 10),
  newsMaxPerRun: Number(process.env.NEWS_MAX_PER_RUN ?? 3),
  /** Фирменный цвет — барный янтарный */
  color: 0xe8a33d,
};
