import json, os, re, sys

m = json.load(open('ghost.json'))
fail = []


def chk(cond, msg):
    print(('ok   ' if cond else 'FAIL ') + msg)
    if not cond:
        fail.append(msg)


chk(m['schemaVersion'] == 3, 'schemaVersion 3')
chk(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}', m['id']) is not None, 'id pattern ' + m['id'])
chk(len(m['description']) <= 300, 'description %d<=300' % len(m['description']))
chk(len(m['whenToUse']) <= 300, 'whenToUse %d<=300' % len(m['whenToUse']))
chk(re.fullmatch(r'\d+\.\d+\.\d+', m['minCindyVersion']) is not None, 'minCindyVersion semver ' + m['minCindyVersion'])
chk(os.path.isfile(m['entry']), 'entry exists')

for t in m['tools']:
    n = t['name']
    ok = re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', n) is not None
    size = len(json.dumps(t['parameters'], ensure_ascii=False).encode())
    chk(ok and size <= 16384, 'tool %s (schema %d bytes)' % (n, size))
    chk(t['parameters'].get('type') == 'object', 'tool %s parameters is an object schema' % n)

nw = m['network']
chk(1 <= len(nw['hosts']) <= 8, 'hosts count %d<=8' % len(nw['hosts']))
for h in nw['hosts']:
    chk(re.fullmatch(r'(?:[a-z0-9-]+\.)+[a-z]{2,}', h) is not None, 'host ' + h)
for s in nw['secrets']:
    chk(re.fullmatch(r'[a-z][a-z0-9_]{0,31}', s['key']) is not None, 'secret key ' + s['key'])
    chk(s['inject']['format'].count('{value}') == 1, 'inject format has one {value}')
    chk(s['inject']['header'] not in ('Host', 'Cookie'), 'inject header not reserved')
    chk(s.get('source', 'user') == 'user', 'secret source is user')
chk(os.path.isfile(m['settingsHtml']), 'settingsHtml exists (required with a user secret)')
for req in m['setup']['requires']:
    for ref in req['anyOf']:
        chk(ref == 'secret:' + nw['secrets'][0]['key'], 'setup ref resolves: ' + ref)

p = m['panel']
chk(p['position'] in ('left', 'right', 'top', 'bottom', 'tab'), 'panel position ' + p['position'])
chk(os.path.isfile(p['html']), 'panel.html exists')
chk(not (p['position'] == 'tab' and ('minWidth' in p or 'defaultFraction' in p)), 'no width fields on tab panel')

sk = m['skill']['items'][0]
chk(os.path.isfile(os.path.join(sk['dir'], 'SKILL.md')), 'SKILL.md exists at ' + sk['dir'])
chk(len(sk['description']) <= 1024, 'skill description %d<=1024' % len(sk['description']))
chk(re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', sk['name']) is not None, 'skill name pattern ' + sk['name'])
chk(len(m['skill']['items']) <= 4, '<=4 skills')
chk('en' in m['readme'] and os.path.isfile(m['readme']['en']), 'readme.en exists')

for page in (p['html'], m['settingsHtml']):
    for ref in re.findall(r'(?:src|href)="/([^"]+)"', open(page, encoding='utf-8').read()):
        chk(os.path.isfile(ref), '%s -> %s' % (page, ref))

# --- documentation must match the shipped capabilities -------------------------
# The marketplace review rejected 0.2.1 and 0.2.2 for the same defect: the code
# unbinds a device while README/SKILL still said removal was unsupported. Both
# rejections consumed a version number, so the contradiction is now a test.

docs = ['README.md', os.path.join('..', 'docs', 'AGENTS-plugin.md'), os.path.join(sk['dir'], 'SKILL.md'), m['settingsHtml']]
docs = [d for d in docs if os.path.isfile(d)]
texts = {d: open(d, encoding='utf-8').read() for d in docs}

LIES = [
    r'no pairing or removing',
    r'no pairing/removal',
    r'pairing/removal',
    r'pairing or remov\w* devices?',
    r'(?:cannot|can not|does not|doesn\'t|no) [a-z ]{0,20}remov\w*',
    r'removal is not supported',
    r'不支持.{0,6}(移除|解绑)',
]
for doc, text in texts.items():
    for pat in LIES:
        hit = re.search(pat, text, re.IGNORECASE)
        chk(hit is None, 'no false "no removal" claim in %s%s' % (doc, '' if hit is None else ': ' + repr(hit.group(0))))

tools = {t['name'] for t in m['tools']}
if 'remove_device' in tools:
    # Every page a user or reviewer reads must describe the destructive tool.
    for doc, text in texts.items():
        chk(re.search(r'unbind|unpair|remove_device|(?:remove|unbind)\w* a device', text, re.IGNORECASE) is not None,
            '%s mentions unbinding a device' % doc)
    readme = texts.get('README.md', '')
    skill = texts.get(os.path.join(sk['dir'], 'SKILL.md'), '')
    for doc, text in (('README.md', readme), (sk['dir'] + '/SKILL.md', skill)):
        for need, why in (
            (r'advanced', 'names the advanced setting'),
            (r'confirm_device_id', 'names confirm_device_id'),
            (r'pa(?:ir|ired|iring)', 'says the device must be paired again'),
            (r'(?:allowed to manage|manage this home|permission family|1010)', 'states the key permission it needs'),
        ):
            chk(re.search(need, text, re.IGNORECASE) is not None, '%s %s' % (doc, why))

# The packer matches the skill folder against skill.items; a silent drift here
# renames the skill the agent sees, so compare the frontmatter byte for byte.
fm = open(os.path.join(sk['dir'], 'SKILL.md'), encoding='utf-8').read()
fm = fm.split('---')[1] if fm.startswith('---') else ''
fm_name = (re.search(r'^name:\s*(.+)$', fm, re.M) or [None, ''])[1].strip()
fm_desc = (re.search(r'^description:\s*(.+)$', fm, re.M) or [None, ''])[1].strip()
if len(fm_desc) > 1 and fm_desc[0] == fm_desc[-1] and fm_desc[0] in '"\'':
    fm_desc = fm_desc[1:-1]
chk(fm_name == sk['name'], 'SKILL.md name matches skill.items (' + fm_name + ')')
chk(fm_desc == sk['description'], 'SKILL.md description matches skill.items byte for byte')

# Release notes travel inside the package. Absent is allowed for a first listing,
# a non-string is not.
if 'releaseNotes' in m:
    chk(isinstance(m['releaseNotes'], str) and len(m['releaseNotes'].strip()) > 40,
        'releaseNotes is plain text and describes the change')

# docs/INSTALL.md is not in the package, but it is the page a user reads before
# installing: every errorCode it documents must exist in one of the two codebases.
install_doc = os.path.join('..', 'docs', 'INSTALL.md')
if os.path.isfile(install_doc):
    sources = open('main.js', encoding='utf-8').read()
    mcp = os.path.join('..', 'variants', 'mcp', 'tuya_mcp.py')
    if os.path.isfile(mcp):
        sources += open(mcp, encoding='utf-8').read()
    doc = open(install_doc, encoding='utf-8').read()
    marker = '## Troubleshooting'
    doc = doc[doc.index(marker):] if marker in doc else ''
    for line in doc.splitlines():
        cells = line.split('|')
        if len(cells) < 2:
            continue
        for code in re.findall(r'`([A-Z][A-Z_]{2,})`', cells[1]):
            chk(("'" + code + "'") in sources or ('"' + code + '"') in sources,
                'INSTALL.md documents errorCode ' + code + ' that the code emits')

# No personal account data in the package: real Tuya device ids are 20 chars of
# lowercase alphanumerics and every shipped doc must be free of them.
for doc, text in texts.items():
    chk(re.search(r'\b[a-z0-9]{18,22}\b', text) is None or doc == m['settingsHtml'],
        'no device-id-like strings in %s' % doc)

# A switch code the code accepts must be named in the README, or the user reads a
# complete-looking list that silently omits one.
src = open('main.js', encoding='utf-8').read()
match = re.search(r'const SWITCH_CODES = \[(.*?)\]', src, re.S)
if match:
    for code in re.findall(r"'([a-z0-9_]+)'", match.group(1)):
        chk(code in texts.get('README.md', ''),
            'README names the switch code ' + code + ' the panel button accepts')

# TOOLS in main.js and the manifest's tool list are two copies of the surface the
# host exposes; a drift here means a tool exists in one place only.
tool_map = re.search(r'const TOOLS = \{(.*?)\n\};', src, re.S)
if tool_map:
    wired = set(re.findall(r'^\s*([a-z_]+):', tool_map.group(1), re.M))
    chk(wired == tools, 'main.js TOOLS match ghost.json tools (%d)' % len(wired))

# The panel talks to the brain with action literals; a page action the brain does
# not handle fails silently at the user's click.
brain_actions = set(re.findall(r"msg\.action === '([a-z-]+)'", src))
for page in ('panel.js', 'settings.js'):
    page_src = open(page, encoding='utf-8').read()
    page_actions = set(re.findall(r"action: '([a-z-]+)'", page_src))
    page_actions |= set(re.findall(r"(?:ask|askPanel)\('([a-z-]+)'", page_src))
    unknown = sorted(page_actions - brain_actions)
    chk(not unknown, '%s actions are handled by the brain' % page + ('' if not unknown else ': ' + ', '.join(unknown)))

# Discovery probes every centre in main.js; a host missing from the manifest is
# blocked by the host before the request leaves, so the two tables must match.
src_hosts = re.findall(r"base: 'https://([^']+)'", src)
chk(set(src_hosts) == set(nw['hosts']),
    'ghost hosts match DATA_CENTRES (%d centres)' % len(src_hosts))

# Every /kv key the settings page writes must be one the brain reads, or a
# toggle flips a value nothing honours.
settings_src_full = open('settings.js', encoding='utf-8').read()
brain_keys = set(re.findall(r'kv(?:Before|After)?[.]([A-Za-z][A-Za-z0-9]*)', src))
written_keys = set()
for block in re.findall(r'writeKv\(\{([^}]*)\}', settings_src_full):
    written_keys |= set(re.findall(r'([A-Za-z][A-Za-z0-9]*)\s*:', block))
unread = sorted(written_keys - brain_keys)
chk(not unread, 'settings.js kv keys are read by the brain' + ('' if not unread else ': ' + ', '.join(unread)))

# The code emits codes, the docs list them. Check the direction nothing else does:
# a new TuyaError code that never reaches INSTALL.md is invisible to the user.
PANEL_ONLY = {'UNKNOWN_ACTION'}
emitted = set(re.findall(r"new TuyaError\(\s*'([A-Z][A-Z_]+)'", src))
undocumented = sorted(emitted - PANEL_ONLY - {c for c in emitted if ('`' + c + '`') in open(install_doc, encoding='utf-8').read()}) if os.path.isfile(install_doc) else []
chk(not undocumented, 'every emitted errorCode is documented in INSTALL.md' + ('' if not undocumented else ': ' + ', '.join(undocumented)))

# The settings page talks to the host vault under a hardcoded key; it must be the
# key the manifest declares, or saving a key silently does nothing.
settings_src = open('settings.js', encoding='utf-8').read()
settings_key = re.search(r"const SECRET_KEY = '([^']+)'", settings_src)
chk(settings_key is not None and settings_key.group(1) == nw['secrets'][0]['key'],
    'settings.js SECRET_KEY matches the manifest secret key')

print('\nfiles:')
for root, dirs, files in os.walk('.'):
    for f in sorted(files):
        print('   ' + os.path.join(root, f).replace(os.sep, '/'))

print('\nFAILURES: %d' % len(fail))
sys.exit(1 if fail else 0)
