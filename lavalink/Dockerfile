# Lavalink + плагин Soundy.
# Встроенный источник SoundCloud в Lavalink сломан с 2026 года (SoundCloud сменил формат потоков,
# поиск отдаёт ошибку). Soundy — плагин-замена. Готового jar в релизах нет, поэтому собираем из исходников.

FROM eclipse-temurin:17-jdk AS soundy
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
ARG SOUNDY_REPO=https://github.com/lowkwrs/soundy.git
ARG SOUNDY_REF=main
WORKDIR /src
RUN git clone "$SOUNDY_REPO" . && git checkout "$SOUNDY_REF"
RUN chmod +x gradlew && ./gradlew :plugin:jar --no-daemon -q
RUN mkdir /out \
 && find plugin/build/libs -name '*.jar' ! -name '*-sources.jar' ! -name '*-javadoc.jar' -exec cp {} /out/ \; \
 && ls -la /out

FROM ghcr.io/lavalink-devs/lavalink:4
COPY --from=soundy --chown=322:322 /out/ /opt/Lavalink/plugins/
