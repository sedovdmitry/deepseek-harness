# Harness: обновление, откат и грабли

Документ описывает:

- рабочую конфигурацию репозитория и как её восстановить;
- архитектурные причины, почему обновление на новый upstream сломалось;
- пошаговый процесс переноса своих коммитов на новый upstream без поломки харнесса.

> Репозиторий: `C:\TOOLS\deepseek-harness`
> Рабочий shell: MINGW64
> Node: `^22.19.0 || >=24.0.0` (старая база), `>=24.9.0` (новый upstream)
> pnpm: `11.7.0` для `local-work`, `11.28.5` для `temp-rebase` (corepack переключает сам)

---

## 1. TL;DR — что сейчас работает

Рабочая ветка — **`local-work`**, коммит `a5d01f6f48`.
Если что-то пошло не так, восстановление:

```bash
git switch local-work
git status                                    # должно быть clean (кроме audio/ и data/)
git log -1 --oneline                          # a5d01f6f48 local/config: ...

# если node_modules остались от другой ветки
rm -rf node_modules
pnpm install --frozen-lockfile

# ОБЯЗАТЕЛЬНО перед сборкой после смены ветки
pnpm run clean

pnpm run build

# перезапуск через ярлык / dsh-restart.ps1
curl -fsS http://127.0.0.1:3080/ -o dsh-index.html && echo OK
```

`OK` в конце = харнесс поднялся.

---

## 2. Устройство веток

```
c291e7961a  (origin/master) Merge PR #3977 release 0.1.5-rc.2      ← старый upstream
   │
   ├── d5ddfabf64  feat(tools): restrict() deny reaches the scope's own registrations
   ├── c5bd0e6fd4  test(subagent): expect updated restrict() message
   ├── e1fe1c164c  fix(tools): lenient restrict() validation...    ← master
   │
   ├── 0d3b617da8  local/npmrc: hoisted node-linker required for pnpm install   ← КРИТИЧНО
   ├── ee75cfe206  local/cache-clock: token cache clock package and host wiring
   ├── 5cc6254092  local/ui-chat: stats pills and locale adjustments
   └── a5d01f6f48  local/config: tsconfigs, bundle patch, ignore and agent docs ← РАБОЧАЯ

ce7073d512  (fork/master) Merge PR #7552 ...                        ← новый upstream (2026-10-30)
   │
   ├── 135964b9f9  feat(tools): restrict() deny reaches...         ┐
   ├── ea85b24880  test(subagent): expect updated restrict()...     │ ребейз тех же
   ├── 132c4dd1fc  fix(tools): lenient restrict() validation...     ┘ коммитов
   └── b741198624  Ignore audio/ and data/                         ← temp-rebase (СЛОМАНА)
```

### Роли веток

| Ветка                    | Что это                                                                          | Для запуска                               |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `local-work`             | Старый upstream + 3 своих коммита + **4 локальных конфиг-коммита**. **Рабочая.** | ✅ Да                                     |
| `master`                 | Старый upstream + 3 своих коммита, **без локального конфига**.                   | ❌ Нет (нет `.npmrc`, нет `bundle patch`) |
| `temp-rebase`            | Новый upstream + 3 своих коммита (ребейз), **без локального конфига**. Сломана.  | ❌ Нет                                    |
| `fork/master`            | Чистый новый upstream.                                                           | ❌ Нет                                    |
| `backup-before-rollback` | Снимок `temp-rebase` перед откатом. Страховка.                                   | ❌ Нет                                    |
| `origin/master`          | Старый upstream, база `0.1.5-rc.2`.                                              | ❌ Нет                                    |

**Ключевой вывод:** рабочая сборка живёт **только** на `local-work`, потому что в ней есть четыре локальных коммита (`0d3b617da8`, `ee75cfe206`, `5cc6254092`, `a5d01f6f48`), которых нет ни в одной другой ветке. Без первых двух (`npmrc` и `bundle patch`) харнесс не запускается — см. раздел 3.

---

## 3. Архитектурные причины, почему обновление на новый upstream сломалось

При обновлении через `git merge fork/master` (или `rebase`) в `temp-rebase` **не были перенесены** четыре локальных конфиг-коммита из `local-work`. Это дало каскад из пяти независимых проблем.

### 3.1. Потерян `.npmrc` с `node-linker=hoisted` — отсюда `Cannot find module ... openai-completions.js`

Коммит `0d3b617da8 local/npmrc: hoisted node-linker required for pnpm install` добавляет в корень `.npmrc`:

```
node-linker=hoisted
```

**Что это даёт.** По умолчанию pnpm использует _isolated_ linker: пакеты лежат в `.pnpm/<pkg>@<ver>_<hash>/node_modules/...`, а в корне — симлинки. На Windows это создаёт очень длинные пути:

```
node_modules\.pnpm\@earendil-works+pi-ai@0.85._3b628cb9573a967ca43271c0a3ead452\node_modules\@earendil-works\pi-ai\dist\api\openai-completions.js
```

`@earendil-works/pi-ai` использует **lazy dynamic import**: `openai-completions.lazy.js` подгружает `openai-completions.js` при первом вызове. На isolated-linker в глубоких путях этот динамический import на Windows падает:

```
Cannot find module 'C:\TOOLS\...\pi-ai@0.85._3b6...\dist\api\openai-completions.js'
imported from ...openai-completions.lazy.js
```

**`node-linker=hoisted`** делает `node_modules` плоским (как у npm): `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` лежит по короткому пути. Проблема исчезает.

**Вывод:** без этого `.npmrc` любой `pnpm install` на новом upstream снова воспроизведёт исходную ошибку `openai-completions.js`.

### 3.2. Потерян `bundle patch` — отсюда `window.__ModuleLoader__ bootstrap facade is missing`

Коммит `a5d01f6f48 local/config: tsconfigs, bundle patch, ignore and agent docs` содержит локальную правку бандла web-приложения. Без неё HTML-шелл, который отдаёт Host на `http://127.0.0.1:3080/`, ссылается на bootstrap-бандлы (`/plugins/...?rev=...`) с одним revision, а фактически отдаваемые байты относятся к другому. Boot-ядро ждёт, что `window.__ModuleLoader__` будет установлен фасадом, но фасад не выполняется — и загрузка падает с:

```
Failed to load plugins
web boot: window.__ModuleLoader__ bootstrap facade is missing
```

**Вывод:** это не «сломанный плагин» и не права доступа. Это рассинхронизация HTML и бандлов, которую чинит именно `bundle patch` из `local-work`.

### 3.3. Stale build-артефакты переживают `git switch` — отсюда 120 ошибок `tsc`

`lib/` и `dist/` в `.gitignore`, поэтому `git switch` их **не трогает**. Они остаются от последней сборки — а она была на `temp-rebase`. Когда вы переключились на `local-work` и запустили `pnpm run build`, `tsc` резолвил типы **из stale `.d.ts`** нового API, а тесты в `local-work` написаны под старый API:

```
apps/desktop/tests/update-coordinator.spec.ts:71
  coordinator.install()                          ← тест (старый API, без аргументов)
  apps/desktop/lib/types/update-coordinator.d.ts:51
    install(version: string): Promise<...>       ← тип (новый API, с аргументом)
```

Те же 120 ошибок — из той же серии: `DesktopPaths.root`, `runtime.pnpm`, `mutate()`, `listPlugins()`, `profileRecovery`, `desktopRuntimeId`, `DshDesktopStartupApi`. Все они — «старый тест ↔ новый `.d.ts` из stale `lib/`».

**Вывод:** между `git switch` и `pnpm run build` **обязателен `pnpm run clean`** (`scripts/clean.ts`, снёс 413 путей). Без него сборка падает, и кажется, что сломан код, хотя на самом деле сломаны артефакты.

### 3.4. API drift между `0.1.5-rc.2` и новым upstream

Новый upstream внёс несовместимые изменения в публичный API тестовых утилит. Файл `packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts` в `temp-rebase` — **новый** (`new file`), и он ломает `host aggregate check`:

| Что сломалось                                  | Причина                                                  | Куда чинить                              |
| ---------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `@deepseek-ai/dsh-invariants`, `.../invariant` | Пакет инвариантов удалён из upstream                     | Убрать импорты                           |
| `defineContentToolFixture` из `dsh-tools`      | Переехал                                                 | Брать из `@deepseek-ai/dsh-tool-testkit` |
| `'../src/index.ts'`                            | `tsc` без `allowImportingTsExtensions` не резолвит `.ts` | `'../src'`                               |
| `'one-shot'` vs `'continuable'`                | Поле сузилось                                            | Привести к новому типу                   |
| `'plugin'` vs union из 60+ значений            | Поле `kind` расширилось                                  | Привести к валидному значению            |

Из-за этого `tsc -p tsconfig.host.json` падал, `pnpm run build` завершался с `exit 2`, артефакты не генерировались, и Host на `3080` не поднимался (`curl: (7) Failed to connect`). То есть `__ModuleLoader__` была **следствием**, а не причиной.

### 3.5. Смена требования к Node и поведение `nvm-windows`

- Старая база: `"engines": { "node": "^22.19.0 || >=24.0.0" }`
- Новый upstream: `"engines": { "node": ">=24.9.0" }`

При `nvm use 24` шимы `pnpm` **исчезают** из PATH, потому что `nvm-windows` держит их внутри каталога версии Node (`C:\nvm4w\v24.22.2\`), а не глобально. Отсюда:

```
bash: /c/nvm4w/nodejs/pnpm: No such file or directory
```

Лечится `corepack enable pnpm` после `nvm use 24` (или `npm i -g pnpm@<ver>`).

Дополнительно: `pnpm store prune` на Windows может падать с `EPERM: operation not permitted, unlink ...` — это **лок файла** антивирусом или висящим `node.exe`, а не порча store. Не блокер: если `pnpm install` завершился успешно, prune можно пропустить.

---

## 4. Пошаговое восстановление рабочей версии

Используйте, если харнесс не запускается, а вам нужно быстро вернуться к работе.

### 4.1. Страховка

```bash
git branch backup-before-rollback      # снимок текущего состояния
```

### 4.2. Переключение

```bash
git switch local-work
git log -1 --oneline                   # a5d01f6f48
git status                             # clean, кроме audio/ и data/
```

### 4.3. Node

```bash
git show local-work:package.json | grep -A3 '"engines"'
# ^22.19.0 || >=24.0.0  → подойдёт и 22, и 24

# если на 24 и pnpm пропал:
corepack enable pnpm
```

### 4.4. Зависимости

```bash
rm -rf node_modules
pnpm install --frozen-lockfile
```

`--frozen-lockfile` обязателен: запрещает pnpm обновлять lockfile и гарантирует ровно те версии, что записаны в коммите.

### 4.5. Очистка build-артефактов

```bash
pnpm run clean
# → clean: removed 413 paths
```

Именно этот шаг убирает stale `.d.ts` от предыдущей ветки. `apps/plugin-market-generator/lib` и `apps/web/dist` `clean` оставляет намеренно — они пересоздаются гейтами `Desktop bundle` и `Web build`.

### 4.6. Сборка

```bash
pnpm run build
```

Ожидаемые строки:

```
run-gates: PASS native addon
run-gates: PASS Host Typert
run-gates: PASS host compiler
run-gates: PASS Host bundle
run-gates: PASS Desktop bundle
run-gates: PASS client compiler
run-gates: PASS Client bundle
run-gates: PASS Web build
run-gates: 10 passed, 0 failed
```

Гейта `host aggregate check` с `subagent-in-process-driver.spec.ts` быть не должно — этого файла в `0.1.5-rc.2` нет.

### 4.7. Запуск

```bash
# ярлык / dsh-restart.ps1 — как обычно
curl -fsS http://127.0.0.1:3080/ -o dsh-index.html && echo OK
```

`OK` = харнесс поднялся.

---

## 5. Инструкция: перенос своих коммитов на новый upstream (в следующий раз)

Порядок **критичен**. Нарушение порядка = поломка харнесса.

### 5.1. Pre-flight

```bash
# 1) страховка
git branch backup-before-update

# 2) убедиться, что рабочая версия local-work собирается и запускается
#    (см. раздел 4)

# 3) зафиксировать текущее состояние
git log --oneline local-work -8
git log --oneline fork/master -3
```

### 5.2. Создать рабочую ветку от нового upstream

```bash
git switch -c update-<date> fork/master
```

### 5.3. Cherry-pick в строгом порядке

```bash
# 1) КРИТИЧНО: hoisted linker
git cherry-pick 0d3b617da8

# 2) КРИТИЧНО: bundle patch + tsconfigs + ignore
git cherry-pick a5d01f6f48

# 3) локальные фичи (порядок между ними не важен)
git cherry-pick ee75cfe206
git cherry-pick 5cc6254092

# 4) свои коммиты
git cherry-pick d5ddfabf64
git cherry-pick c5bd0e6fd4
git cherry-pick e1fe1c164c
```

После шага 1 проверьте, что `.npmrc` на месте:

```bash
cat .npmrc
# node-linker=hoisted
```

Без этого следующие шаги бессмысленны — `pnpm install` снова уйдёт в isolated-linker.

### 5.4. Починить `subagent-in-process-driver.spec.ts`

Этот файл пришёл из нового upstream и **не соответствует** актуальному API. Варианты:

**A. Взять актуальную версию из upstream**, если она есть:

```bash
git show fork/master:packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts \
  > packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts
```

**B. Адаптировать вручную** — правки по таблице 3.4:

- убрать `import InvariantRegistry from '@deepseek-ai/dsh-invariants'` и все `.../invariant`;
- `import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'` → `'@deepseek-ai/dsh-tool-testkit'`;
- `from '../src/index.ts'` → `from '../src'`;
- `'one-shot'` → `'continuable'` (для `mode`);
- `'plugin'` → валидное значение из union `kind` (посмотреть в типах `src/`).

### 5.5. Установка и сборка

```bash
rm -rf node_modules
pnpm install --frozen-lockfile
pnpm run clean
pnpm run build
```

Все 10 гейтов должны быть `PASS`.

### 5.6. Проверка запуска

```bash
# ярлык / dsh-restart.ps1
curl -fsS http://127.0.0.1:3080/ -o dsh-index.html && echo OK
```

`OK` = обновление прошло успешно. Если нет — см. раздел 6.

### 5.7. Если всё зелёное — закрепить

```bash
git switch local-work
git merge --ff-only update-<date>
# или переименовать ветку, если хотите оставить её как основную
```

---

## 6. Известные грабли: симптом → причина → лечение

| Симптом                                                                                                    | Причина                                                           | Лечение                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find module ... openai-completions.js`                                                             | Нет `.npmrc` с `node-linker=hoisted`; pnpm ушёл в isolated-linker | `git cherry-pick 0d3b617da8`, затем `rm -rf node_modules && pnpm install --frozen-lockfile`                                              |
| `window.__ModuleLoader__ bootstrap facade is missing`                                                      | Нет `bundle patch`; HTML и бандлы из разных revision              | `git cherry-pick a5d01f6f48`, затем `pnpm run clean && pnpm run build`                                                                   |
| `curl: (7) Failed to connect to 127.0.0.1:3080`                                                            | Сборка упала, Host не стартовал                                   | Смотреть вывод `pnpm run build`, чинить причину                                                                                          |
| `120 ошибок tsc` про `install()`, `paths.root`, `runtime.pnpm`, `mutate`, `listPlugins`, `profileRecovery` | Stale `lib/` от другой ветки                                      | `pnpm run clean` перед `pnpm run build`                                                                                                  |
| `TS2307: Cannot find module '@deepseek-ai/dsh-invariants'`                                                 | Тест из нового upstream, API drift                                | См. 5.4                                                                                                                                  |
| `TS2614: no exported member 'defineContentToolFixture'`                                                    | Переехал                                                          | Импортировать из `@deepseek-ai/dsh-tool-testkit`                                                                                         |
| `TS2307: Cannot find module '../src/index.ts'`                                                             | `tsc` без `allowImportingTsExtensions`                            | `'../src'` без `.ts`                                                                                                                     |
| `TS2322: '"one-shot"' not assignable to '"continuable"'`                                                   | Поле сузилось                                                     | Привести к новому типу                                                                                                                   |
| `Unsupported engine: wanted: {"node":">=24.9.0"}`                                                          | Node 22 на новом upstream                                         | `nvm install 24 && nvm use 24 && corepack enable pnpm`                                                                                   |
| `bash: /c/nvm4w/nodejs/pnpm: No such file or directory`                                                    | `nvm use 24` убрал шимы pnpm                                      | `corepack enable pnpm` (или `npm i -g pnpm@<ver>`)                                                                                       |
| `EPERM: operation not permitted, unlink ...pnpm\store\v11\files\...`                                       | Лок файла антивирусом или висящим `node.exe`                      | Не блокер, если `pnpm install` прошёл. Иначе — закрыть Node, добавить `C:\Users\<user>\AppData\Local\pnpm\store` в исключения антивируса |
| `[ERR_PNPM_ADDING_TO_ROOT]`                                                                                | `pnpm add` в корне монорепо                                       | `-w` (`--workspace-root`) или `pnpm update <pkg> -w`                                                                                     |

---

## 7. Полезные команды

```bash
# Состояние веток
git log --oneline --graph --all -30
git branch -vv

# Проверка .npmrc
cat .npmrc

# Проверка Node-требований ветки
git show <branch>:package.json | grep -A3 '"engines"'

# Проверка, что .npmrc не потерян при cherry-pick
git log --oneline local-work -8 | grep -i npmrc

# Полная чистая переустановка
rm -rf node_modules && pnpm install --frozen-lockfile

# Очистка build-артефактов (штатная)
pnpm run clean

# Точечная чистка, если clean не помог
find . -type d \( -name lib -o -name dist \) \
  -not -path "*/node_modules/*" -prune -exec rm -rf {} +
find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete

# Проверка, что сервер поднялся
curl -fsS http://127.0.0.1:3080/ -o dsh-index.html && echo OK
```

---

## 8. Чек-лист «обновление не сломалось»

Перед тем как считать обновление завершённым:

- [ ] `.npmrc` содержит `node-linker=hoisted`
- [ ] `bundle patch` из `a5d01f6f48` на месте (`git log --oneline | grep 'local/config'`)
- [ ] `pnpm install --frozen-lockfile` прошёл без ошибок
- [ ] `pnpm run clean` выполнен **после** `git switch`
- [ ] `pnpm run build` — все 10 гейтов `PASS`
- [ ] `curl http://127.0.0.1:3080/` возвращает `OK`
- [ ] В браузере страница грузится, плагины видны (нет `__ModuleLoader__`)
- [ ] В логах харнесса нет `PI_AI_ERROR` / `Cannot find module`

Если все пункты выполнены — обновление состоялось. Если нет — откат по разделу 4.

---

## 9. Почему `audio/` и `data/` в untracked

Это runtime-данные, не часть исходников. В `temp-rebase` они добавлены в `.gitignore` коммитом `b741198624`. В `local-work` этого коммита нет, поэтому они видны как untracked. Если мешает — добавьте и здесь:

```bash
printf 'audio/\ndata/\n' >> .gitignore
git add .gitignore && git commit -m "Ignore audio/ and data/"
```

На запуск не влияет.

---

## 10. Адаптация `subagent-in-process-driver.spec.ts` — ДИАГНОСТИКА ЗАВЕРШЕНА (2026-12-19)

Прогнали раздел 10.0 против `fork/master`. Итог: **ручная адаптация НЕ нужна — путь 10.0.2.**

- `packages/subagent/subagent-in-process-driver/` целиком удалён в новом upstream:
  - `3d852a1cea` refactor(subagent): unify local and external activation lifecycles
  - `15f2997bcb` cleanup: omit unneeded invariant companions (это же убрало `dsh-invariants` и subpath-экспорты `.../invariant`)
- `startInProcessRun` в `src/` upstream не существует — только в `docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md`.
- Замена: **managed subagent activations** — `subagents.startActivation({ provider, label, request, signal, delivery: 'caller' })` вместо `start()`/`startContinuable()`/foreground-результатов; `backgroundMode`/`enableRunInBackground`/`run_in_background` удалены из `dsh-tool-subagent`; результат приходит completion-notice'ом, остановка — `interrupt_agent`.

### Что делать при переезде (вместо пункта 5.4)

1. `git rm -r packages/subagent/subagent-in-process-driver/` — тест умирает вместе с пакетом, адаптировать нечего.
2. Проверить наши конфиги (`cordis.yml`, профили, патчи) на `backgroundMode` / `enableRunInBackground` / `run_in_background` — убрать по гайду.
3. Если наш код звал `start()`/`startContinuable()` — перевести на `startActivation()` по примерам гайда.
4. Пункты 10.1–10.5 (инварианты, fixture, `.ts`-импорты, `mode`, `source.kind`) — актуальны только для остальных тестов, переносимых из старой базы; для driver-спека — неактуальны.

Чек-лист 10.8 выполняется автоматически: файл не переносится вовсе.

### 10.1 Грабля миграции (реальный случай, 2026-10-31): слушатели `session/event`

Наш плагин `dsh-cache-clock` после переезда молчал: новый upstream диспетчит
`session/event` **скоупированно** — root-слушатель без опций их не получает.
Лечение: `ctx.on('session/event', (session, event) => {...}, { global: true })`
(эталон — `packages/client/ui-trajectory/tests/tool-results.host.spec.ts`).
Симптом: плагин смонтирован, эмиссию слышит сам, но событий сессий не видит.
Отладка: временный `appendFileSync`-пробник в конструкторе плагина
(монтирование / события / публикация) — консоли хоста у нас нет.

Ещё две грабли того же дня:
- рев-манифест плагинов `/plugins/??...&rev=` фиксируется при старте хоста —
  пересборка клиентского плагина без рестарта для браузера невидима;
- `dsh-llm-agentrouter@2.1.0` скипается новым ядром как несовместимый
  (нужен апгрейд плагина или `dsh plugin allow-version`).

---

## 11. Полная инструкция адаптации `subagent-in-process-driver.spec.ts` (если бы файл был нужен)

Раздел применим к **любому** тесту, переносимому из старой базы, который начинает
падать на типах после обновления. Порядок: сначала диагностика (10.0 / раздел выше),
и только потом правки. Для driver-спека диагностика дала исход «пакет удалён» —
правки ниже к нему НЕ применяются.

### 11.1. Инварианты

**Симптом:** `TS2307: Cannot find module '@deepseek-ai/dsh-invariants'` и `.../invariant`.

**Проверка, куда делись:**

```bash
git grep -l 'InvariantRegistry' fork/master -- 'packages/**' | head
git ls-tree -r fork/master --name-only | grep -i invariant | head
git grep -n '"/invariant"' fork/master -- 'packages/**/package.json'
```

- **Вариант A — переехали/переименованы:** заменить импорты на новые пути.
- **Вариант B — удалены (наш случай, `15f2997bcb`):** убрать импорты, функцию
  `mountInvariants` и её вызов из `setup()`. Безопасно — инварианты
  runtime-diagnostics, на функциональность не влияют.

### 11.2. `defineContentToolFixture`

**Симптом:** `TS2614: no exported member 'defineContentToolFixture'` (+подсказка про default).

**Проверка (оба варианта):**

```bash
git grep -n 'defineContentToolFixture' fork/master -- 'packages/core/tools/src/**'
git grep -n 'defineContentToolFixture' fork/master -- 'packages/test-support/tool-testkit/src/**'
```

- default из `dsh-tools`: `import defineContentToolFixture from '@deepseek-ai/dsh-tools'`
- переехал: `import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'`
  (проверить `devDependencies` пакета, при отсутствии добавить `"workspace:*"`).

### 11.3. Импорты с расширением `.ts`

`'../src/index.ts'` → `'../src/index'`; то же для `mock-adapter.ts`. Механическая правка.

### 11.4. `'one-shot'` → `'continuable'` — самое опасное место

Может быть (1) переименованием — тогда правки типа достаточно, или (2) сменой
семантики `dispose()` — тогда тест **переписывается**, а не чинится. Проверка:

```bash
git grep -n 'snapshotSubagentDescriptor' fork/master -- 'packages/subagent/subagent/src/**'
git grep -n 'dispose' fork/master -- 'packages/subagent/**/src/**'
```

Если после правки тест падает на `expect(ctx.agents.get(run.id)).toBeUndefined()` —
семантика изменилась: ребёнок остаётся continuable, проверку заменить на новую
контрактную (читать upstream-код).

### 11.5. `'plugin'` в `source.kind`

Union расширился до 70+, `'plugin'` исчез. Подбор по:

```bash
git grep -rn "kind: '" fork/master -- 'packages/**/tests/**' | grep -o "kind: '[^']*'" | sort -u | head -40
```

`'later-contribution'` семантически ближе всего к «позднему дополнению»; иначе
`'user'` (источник для проверки flush не важен). Проверить допустимость поля
`plugin:` у выбранного `kind` — если нет, убрать.

### 11.6. Проверка после правок

```bash
pnpm exec tsc -p tsconfig.host.json --noEmit
pnpm exec vitest run <файл-теста>
pnpm run build   # все 10 гейтов PASS
```

### 11.7. Компромисс, если адаптация затягивается

Переименовать `.spec.ts` → `.spec.ts.disabled` или добавить в `.gitignore` пакета —
сборка пройдёт без теста. Временная мера (дни, не месяцы): отсутствие теста может
скрыть регрессию `dispose()`. Зафиксировать TODO.
