const SPONSORS = [
    '爱发电用户_f6954', '我不会起名', 'xyh', '硕硕小主', 'ZJ_Rider 肆年',
    'MC_不会玩的梓茗同学', 'ffhcv', '爱发电用户_364y', '爱发电用户_Kfq6',
    '爱发电用户_VUch', '峰~', '京墨', '鲨掉', '爱发电用户_ef5f5',
    '爱发电用户_3e0c7', '张琳轩', 'JasonDeng', '熙城种', '妺妤', 'Shanre',
    '爱发电用户_bb606', 'penguinfly_java', '爱发电用户_xKT7', '梦七年', '池鱼',
    'LaiChai', '现金小姐姐', '呼噜', 'nojang_JY', 'ADF白布', 'ffg',
    'sheng_1062', '爱发电用户_f00d6', '爱发电用户_83d3b', '哈喽芋泥', '樻',
    '爱发电用户_xtWd', 'kiroli', '爱发电用户_19443', 'ZYL', '爱发电用户_be45c',
    '爱发电用户_2166c', 'MaoJunyu2012', '纯〇科技', '爱发电用户_39960', '寻自游',
    'skin_c', '竹雾', '爱发电用户_979a9',
    '爱发电用户_7BtT', 'zH', '快夏波', 'lixinmiao', '?', '爱发电用户_5711a',
    '爱发电用户_3e7d0', 'lost', '霖', '爱发电用户_t6hb', '??', '界鱼',
    '爱发电用户_b5d63', '恋爱原计划', 'LADFS', '臻臻公主', '爱发电用户_7CN6',
    '爱发电用户_f15f5', 'Agoin_Y', 'yeccsh', 'k', 'BYX', 'Flugel',
    '爱发电用户_ff69f', '信好有你', '机械小白', '简', '宇宙', '爱发电用户_5ec06',
    '仁', '我嘞个豆', '爱发电用户_wDHc', '与秋赴约', '爱发电用户_rNnt', '雾浔.er',
    '爱发电用户_b0d51', '爱发电用户_afc17', '爱发电用户_e3bc6', '爱发电用户_aa5a6',
    'learen', '爱发电用户_AsWk', 'Fanzezheng', '爱发电用户_d055f', '懿屿',
    '爱发电用户_64272', '爱发电用户_e3b52', '爱发电用户_0fe8d', '爱发电用户_eedfd',
    '爱发电用户_uDkT', '爱发电用户_3c03e', '烬海', 'barnett', '韶末',
    '爱发电用户_TJ3b', '零', '爱发电用户_ab90e', '爱发电用户_a5a98', 'Fish_gods'
];

function renderSponsors(filter) {
    const container = document.getElementById('sponsor-list');
    if (!container) return;

    const keyword = (filter || '').toLowerCase().trim();
    const filtered = keyword
        ? SPONSORS.filter(name => name.toLowerCase().includes(keyword))
        : SPONSORS;

    const countEl = document.getElementById('sponsor-count');
    if (countEl) countEl.textContent = SPONSORS.length + ' 人';

    const moreBtn = document.getElementById('sponsor-more-btn');
    if (moreBtn && !keyword) {
        moreBtn.style.display = SPONSORS.length > 10 ? '' : 'none';
    }

    if (filtered.length === 0) {
        container.innerHTML = '<span class="sponsor-empty">' + (keyword ? '未找到匹配的赞助者' : '暂无赞助者') + '</span>';
        return;
    }

    container.innerHTML = filtered.map(name => {
        return `<div class="sponsor-tag">
            <span class="sponsor-tag-name">${escapeHtml(name)}</span>
        </div>`;
    }).join('');
}

let sponsorExpanded = false;

function toggleShowMoreSponsors() {
    sponsorExpanded = !sponsorExpanded;
    const grid = document.getElementById('sponsor-list');
    const btn = document.getElementById('sponsor-more-btn');
    if (grid) grid.classList.toggle('expanded', sponsorExpanded);
    if (btn) {
        btn.classList.toggle('expanded', sponsorExpanded);
        btn.childNodes[0].textContent = sponsorExpanded ? '收起 ' : '展开更多 ';
    }
}

function filterSponsors(keyword) {
    const grid = document.getElementById('sponsor-list');
    const btn = document.getElementById('sponsor-more-btn');
    if (keyword && keyword.trim()) {
        if (grid) grid.classList.add('expanded');
        if (btn) btn.style.display = 'none';
    } else {
        if (grid) grid.classList.toggle('expanded', sponsorExpanded);
        if (btn) btn.style.display = '';
    }
    renderSponsors(keyword);
}

async function copyMachineId(btn) {
    try {
        const el = document.getElementById('machine-id-display');
        if (!el || !el.value || el.value === '正在获取...') {
            showToast('识别码获取中，请稍候', 'info');
            return;
        }
        if (window.electronAPI && window.electronAPI.clipboard) {
            await window.electronAPI.clipboard.writeText(el.value);
        } else {
            await navigator.clipboard.writeText(el.value);
        }
        const original = btn.textContent;
        btn.textContent = '已复制';
        btn.classList.add('btn-success');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('btn-success'); }, 1500);
        showToast('识别码已复制到剪贴板', 'success');
    } catch (e) {
        showToast('复制失败', 'error');
    }
}

async function loadMachineId() {
    try {
        if (window.electronAPI && window.electronAPI.getMachineId) {
            const id = await window.electronAPI.getMachineId();
            const el = document.getElementById('machine-id-display');
            if (el && id) el.value = id;
        }
    } catch (e) {
        console.error('[MachineId] Failed:', e.message);
    }
}

async function submitActivationCode(btn) {
    const input = document.getElementById('activation-code-input');
    const statusEl = document.getElementById('activation-status');
    if (!input || !statusEl) return;
    const code = input.value.trim();
    if (!code) {
        statusEl.className = 'activation-status failed';
        statusEl.textContent = '请输入激活码';
        return;
    }
    btn.disabled = true;
    btn.textContent = '验证中...';
    statusEl.className = 'activation-status info';
    statusEl.textContent = '正在验证...';
    try {
        const result = await window.electronAPI.activateVerify(code);
        if (result.success) {
            statusEl.className = 'activation-status activated';
            statusEl.textContent = '✓ ' + result.message;
            input.value = '';
            updateActivationStatus();
        } else {
            statusEl.className = 'activation-status failed';
            statusEl.textContent = '✗ ' + result.message;
        }
    } catch (e) {
        statusEl.className = 'activation-status failed';
        statusEl.textContent = '✗ 验证失败';
    }
    btn.disabled = false;
    btn.textContent = '激活';
}

async function updateActivationStatus() {
    try {
        const status = await window.electronAPI.activateStatus();
        const statusEl = document.getElementById('activation-status');
        if (!statusEl) return;
        if (status.activated) {
            statusEl.className = 'activation-status activated';
            const typeLabel = status.type === 'permanent' ? '永久授权' : '单次授权';
            statusEl.textContent = '✓ 已激活 (' + typeLabel + ')';
            const input = document.getElementById('activation-code-input');
            const btn = document.getElementById('activate-btn');
            if (input) input.style.display = 'none';
            if (btn) btn.style.display = 'none';
        }
    } catch (e) {}
}
