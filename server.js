const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

// === 配置区 ===
// 请在此处填入你在智谱申请的 API Key
const GLM_API_KEY = '3a777005edcb4766b81ae40e794f0f92.cMUgvm7ER339luYB'; 
// =============

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// 1. 数据库初始化
const db = new Database('solar_data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS solar_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_metric_time ON solar_metrics(metric_type, timestamp DESC);
`);

const insertMetric = db.prepare('INSERT INTO solar_metrics (timestamp, source, metric_type, value) VALUES (?, ?, ?, ?)');

// 全局内存缓存，用于零延迟响应前端
let globalAiAnalysisCache = "等待核心数据注入与模型推理...";

const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*'
};

// 2. 数据抓取模块
async function fetchNoaaData() {
    try {
        const response = await axios.get('https://services.swpc.noaa.gov/text/daily-solar-indices.txt', { headers: reqHeaders, timeout: 10000 });
        const lines = response.data.trim().split('\n');
        let latestLine = '';
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].startsWith('#') && lines[i].trim() !== '') { latestLine = lines[i].trim(); break; }
        }
        const parts = latestLine.split(/\s+/);
        if (parts.length >= 5) {
            const timestamp = new Date(`${parts[0]}-${parts[1]}-${parts[2]}T00:00:00Z`).getTime();
            insertMetric.run(timestamp, 'NOAA', 'f107_flux', parseInt(parts[3]));
            insertMetric.run(timestamp, 'NOAA', 'sunspot_number', parseInt(parts[4]));
            console.log('[Sync] NOAA daily SSN & F10.7 saved.');
        }
    } catch (error) { console.error('[Error] NOAA SSN/F10.7:', error.message); }
}

async function fetchNoaaKpData() {
    try {
        const response = await axios.get('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', { headers: reqHeaders, timeout: 10000 });
        let data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        if (Array.isArray(data) && data.length > 0) {
            const latestData = data[data.length - 1];
            let timestamp, kpVal;
            if (latestData && latestData.time_tag !== undefined) {
                let timeStr = String(latestData.time_tag).replace(' ', 'T');
                if (!timeStr.endsWith('Z')) timeStr += 'Z';
                timestamp = new Date(timeStr).getTime();
                kpVal = parseFloat(latestData.Kp !== undefined ? latestData.Kp : (latestData.kp !== undefined ? latestData.kp : latestData.Kp_index));
            } else if (Array.isArray(latestData) && latestData.length >= 2) {
                timestamp = new Date(String(latestData[0]).replace(' ', 'T') + 'Z').getTime();
                kpVal = parseFloat(latestData[1]);
            }
            if (timestamp && !isNaN(kpVal)) {
                insertMetric.run(timestamp, 'NOAA', 'kp_index', kpVal);
                console.log('[Sync] NOAA Kp index saved.');
            }
        }
    } catch (error) { console.error('[Error] NOAA Kp:', error.message); }
}

async function fetchSilsoData() {
    try {
        const response = await axios.get('https://www.sidc.be/SILSO/DATA/EISN/EISN_current.txt', { timeout: 10000 });
        const lines = response.data.trim().split('\n');
        const latestLine = lines[lines.length - 1].trim().split(/\s+/);
        const timestamp = new Date(`${latestLine[0]}-${latestLine[1]}-${latestLine[2]}T00:00:00Z`).getTime();
        insertMetric.run(timestamp, 'SILSO', 'sunspot_number', parseInt(latestLine[4]));
        console.log('[Sync] SILSO daily SSN saved.');
    } catch (error) { console.error('[Error] SILSO:', error.message); }
}

async function fetchEsaData() {
    try {
        const response = await axios.get('https://www.sidc.be/products/meu/', { timeout: 10000 });
        const match = response.data.match(/10CM(?: SOLAR)? FLUX\s*[:=]\s*(\d+)/i);
        if (match && match[1]) {
            insertMetric.run(Date.now(), 'ESA_SIDC', 'f107_flux', parseInt(match[1]));
            console.log('[Sync] ESA F10.7 flux saved.');
        }
    } catch (error) { console.error('[Error] ESA:', error.message); }
}

async function fetchGfzKpData() {
    try {
        const now = new Date();
        const endStr = encodeURIComponent(now.toISOString().split('.')[0] + 'Z');
        const startStr = encodeURIComponent(new Date(now.getTime() - 48 * 3600 * 1000).toISOString().split('.')[0] + 'Z');
        const response = await axios.get(`https://kp.gfz-potsdam.de/app/json/?start=${startStr}&end=${endStr}&index=Kp`, { timeout: 10000 });
        const data = response.data;
        let validIndex = data.datetime.length - 1;
        while (validIndex >= 0) {
            const val = data.Kp[validIndex];
            if (val !== null && val !== undefined && val !== '') {
                const kpVal = parseFloat(val);
                if (!isNaN(kpVal)) {
                    const timestamp = new Date(data.datetime[validIndex]).getTime();
                    db.prepare(`DELETE FROM solar_metrics WHERE source = 'GFZ_POTSDAM' AND timestamp > ?`).run(timestamp);
                    insertMetric.run(timestamp, 'GFZ_POTSDAM', 'kp_index', kpVal);
                    console.log(`[Sync] GFZ Kp index saved: ${kpVal}`);
                    break;
                }
            }
            validIndex--;
        }
    } catch (error) { console.error('[Error] GFZ:', error.message); }
}

// 3. 核心：AI 态势感知生成模块 (仅在数据更新后被动调用)
async function generateAiAnalysis() {
    try {
        const stmt = db.prepare(`SELECT metric_type, value FROM solar_metrics GROUP BY metric_type HAVING timestamp = MAX(timestamp)`);
        let ssn = 0, f107 = 0, kp = 0;
        stmt.all().forEach(r => {
            if(r.metric_type === 'sunspot_number') ssn = r.value;
            if(r.metric_type === 'f107_flux') f107 = r.value;
            if(r.metric_type === 'kp_index') kp = r.value;
        });

        const response = await axios.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            model: "glm-4-flash",
            messages: [
                {
                    role: "system", 
                    content: `你是一个极简主义的空间天气解译系统。严禁使用"此外"、"另外"等转折词；严禁使用"AI+"等行业黑话。逻辑直接，事实驱动，极致精简。
必须严格按照以下三行格式输出，不要有任何多余的废话或分点：
观测现象：[用一句话综合评判当前的太阳黑子、射电流量和地磁Kp状态，定性说明整体活动水平]
环境影响：[用一句话直接给出对极光、卫星、通信网络及人体微型电子设备的综合物理影响，严格控制在120字以内]
综合太阳风暴指数：[仅输出1-10的数字]`
                },
                {
                    role: "user", 
                    content: `当前观测：太阳黑子数=${ssn}，F10.7射电流量=${f107}，地磁Kp指数=${kp.toFixed(2)}。生成极简态势感知。`
                }
            ]
        }, { headers: { 'Authorization': `Bearer ${GLM_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });

        globalAiAnalysisCache = response.data.choices[0].message.content;
        console.log('[Sync] AI Analysis generated and cached in memory.');
    } catch (error) {
        console.error('[Error] AI Analysis Generator:', error.message);
    }
}

// 4. 定时调度机制 (采用串行工作流：先等数据全部入库，再触发 AI)
async function runDataSyncWorkflow() {
    console.log('--- Workflow Started: Data Fetching ---');
    await Promise.all([
        fetchNoaaData(),
        fetchNoaaKpData(),
        fetchSilsoData(),
        fetchGfzKpData(),
        fetchEsaData()
    ]);
    console.log('--- Workflow Step 2: Triggering AI Analysis ---');
    await generateAiAnalysis();
}

setTimeout(runDataSyncWorkflow, 2000);
cron.schedule('0 1,13 * * *', runDataSyncWorkflow);

// 5. 统一对外 API 接口
app.get('/api/v1/solar/sunspots', (req, res) => {
    try {
        const stmt = db.prepare(`SELECT source, metric_type, value, timestamp FROM solar_metrics GROUP BY source, metric_type HAVING timestamp = MAX(timestamp)`);
        res.json({
            status: "success", update_time: new Date().toISOString(),
            data: stmt.all().map(row => ({ agency: row.source, metric: row.metric_type, value: row.value, record_time: new Date(row.timestamp).toISOString() }))
        });
    } catch (error) { res.status(500).json({ status: "error", message: "Database query failed" }); }
});

// 极简 API：直接返回内存变量，0 性能损耗
app.get('/api/v1/solar/analysis', (req, res) => {
    res.json({ status: "success", data: globalAiAnalysisCache });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`System running on port ${PORT}.`));