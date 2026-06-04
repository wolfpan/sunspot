const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

// === 配置区 ===
// 请在此处填入你在智谱 (BigModel) 申请的 API Key
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

// 2. 全局通用请求头
const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*'
};

// 3. 数据抓取模块
async function fetchNoaaData() {
    try {
        const response = await axios.get('https://services.swpc.noaa.gov/text/daily-solar-indices.txt', {
            headers: reqHeaders, timeout: 10000
        });
        const lines = response.data.trim().split('\n');
        let latestLine = '';
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].startsWith('#') && lines[i].trim() !== '') {
                latestLine = lines[i].trim();
                break;
            }
        }
        const parts = latestLine.split(/\s+/);
        if (parts.length >= 5) {
            const year = parts[0], month = parts[1], day = parts[2];
            const timestamp = new Date(`${year}-${month}-${day}T00:00:00Z`).getTime();
            insertMetric.run(timestamp, 'NOAA', 'f107_flux', parseInt(parts[3]));
            insertMetric.run(timestamp, 'NOAA', 'sunspot_number', parseInt(parts[4]));
            console.log('[Sync] NOAA daily SSN & F10.7 saved.');
        }
    } catch (error) { console.error('[Error] NOAA SSN/F10.7:', error.message); }
}

async function fetchNoaaKpData() {
    try {
        const response = await axios.get('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', { 
            headers: reqHeaders, timeout: 10000 
        });
        let data = response.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch(e) {}
        }
        if (Array.isArray(data) && data.length > 0) {
            const latestData = data[data.length - 1];
            let timestamp, kpVal;
            if (latestData && latestData.time_tag !== undefined) {
                let timeStr = String(latestData.time_tag);
                if (!timeStr.includes('T')) timeStr = timeStr.replace(' ', 'T');
                if (!timeStr.endsWith('Z')) timeStr += 'Z';
                timestamp = new Date(timeStr).getTime();
                let rawKp = latestData.Kp !== undefined ? latestData.Kp : (latestData.kp !== undefined ? latestData.kp : latestData.Kp_index);
                kpVal = parseFloat(rawKp);
            } else if (Array.isArray(latestData) && latestData.length >= 2) {
                const safeTimeStr = String(latestData[0]).replace(' ', 'T') + 'Z';
                timestamp = new Date(safeTimeStr).getTime();
                kpVal = parseFloat(latestData[1]);
            }
            if (timestamp && !isNaN(kpVal)) {
                insertMetric.run(timestamp, 'NOAA', 'kp_index', kpVal);
                console.log('[Sync] NOAA Kp index saved.');
                return;
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

// GFZ: Kp 指数 (加入防未来脏数据自愈机制)
// GFZ: Kp 指数 (加入防未来脏数据自愈机制)
async function fetchGfzKpData() {
    try {
        const now = new Date();
        const endStr = encodeURIComponent(now.toISOString().split('.')[0] + 'Z');
        const startStr = encodeURIComponent(new Date(now.getTime() - 48 * 3600 * 1000).toISOString().split('.')[0] + 'Z');
        
        const url = `https://kp.gfz-potsdam.de/app/json/?start=${startStr}&end=${endStr}&index=Kp`;
        const response = await axios.get(url, { timeout: 10000 });
        const data = response.data;
        
        let validIndex = data.datetime.length - 1;
        while (validIndex >= 0) {
            const val = data.Kp[validIndex];
            if (val !== null && val !== undefined && val !== '') {
                const kpVal = parseFloat(val);
                if (!isNaN(kpVal)) {
                    const timestamp = new Date(data.datetime[validIndex]).getTime();
                    
                    // 核心修复：自动删除该机构在数据库中可能卡住的“未来时间”脏数据
                    db.prepare(`DELETE FROM solar_metrics WHERE source = 'GFZ_POTSDAM' AND timestamp > ?`).run(timestamp);
                    
                    insertMetric.run(timestamp, 'GFZ_POTSDAM', 'kp_index', kpVal);
                    console.log(`[Sync] GFZ Kp index saved: ${kpVal}`);
                    break;
                }
            }
            validIndex--;
        }
    } catch (error) { 
        console.error('[Error] GFZ:', error.message); 
    }
}

// 4. 定时调度机制
setTimeout(() => { 
    console.log('--- Initial Data Sync Started ---');
    fetchNoaaData(); fetchNoaaKpData(); fetchSilsoData(); fetchGfzKpData(); fetchEsaData();
}, 2000);

cron.schedule('0 1,13 * * *', () => {
    console.log('--- Scheduled Data Sync Started ---');
    fetchNoaaData(); fetchNoaaKpData(); fetchSilsoData(); fetchGfzKpData(); fetchEsaData();
});

// 5. 统一对外 API 接口
app.get('/api/v1/solar/sunspots', (req, res) => {
    try {
        const stmt = db.prepare(`
            SELECT source, metric_type, value, timestamp 
            FROM solar_metrics 
            GROUP BY source, metric_type 
            HAVING timestamp = MAX(timestamp)
        `);
        res.json({
            status: "success",
            update_time: new Date().toISOString(),
            data: stmt.all().map(row => ({
                agency: row.source, metric: row.metric_type, value: row.value, record_time: new Date(row.timestamp).toISOString()
            }))
        });
    } catch (error) {
        res.status(500).json({ status: "error", message: "Database query failed" });
    }
});

// 6. AI 分析接口与内存缓存
let aiAnalysisCache = { text: '', timestamp: 0 };

app.get('/api/v1/solar/analysis', async (req, res) => {
    try {
        // 缓存策略：1小时内直接返回内存数据，减少 API 消耗
        if (Date.now() - aiAnalysisCache.timestamp < 3600000 && aiAnalysisCache.text !== '') {
            return res.json({ status: "success", data: aiAnalysisCache.text });
        }

        // 获取数据库最新聚合值
        const stmt = db.prepare(`SELECT metric_type, value FROM solar_metrics GROUP BY metric_type HAVING timestamp = MAX(timestamp)`);
        const rows = stmt.all();
        let ssn = 0, f107 = 0, kp = 0;
        rows.forEach(r => {
            if(r.metric_type === 'sunspot_number') ssn = r.value;
            if(r.metric_type === 'f107_flux') f107 = r.value;
            if(r.metric_type === 'kp_index') kp = r.value;
        });

        // 注入极简主义的系统约束 Prompt
        const response = await axios.post('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            model: "glm-4-flash",
            messages: [
                {
                    role: "system", 
                    content: `你是一个空间天气解译系统。严禁使用"此外"、"另外"等转折词；严禁使用"AI+"等行业黑话。逻辑直接，事实驱动。
                            你必须严格按照以下多行列表格式输出（不要自由发挥成段落，保留冒号和换行）：
                            地球磁层：[一句话分析]
                            极光可见度：[一句话分析]
                            低轨卫星阻力：[一句话分析]
                            通信与网络：[包含短波、手机信号的一句话分析]
                            微型电子设备：[包含心脏起搏器等设备的一句话分析]
                            综合太阳风暴指数：[仅输出1-10的数字]`
                },
                {
                    role: "user", 
                    content: `当前观测：太阳黑子数=${ssn}，F10.7射电流量=${f107}，地磁Kp指数=${kp.toFixed(2)}。生成态势感知。`
                }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${GLM_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        const analysisText = response.data.choices[0].message.content;
        aiAnalysisCache = { text: analysisText, timestamp: Date.now() }; // 更新缓存
        
        res.json({ status: "success", data: analysisText });
    } catch (error) {
        console.error('[Error] AI Analysis Request Failed:', error.response ? error.response.data : error.message);
        res.status(500).json({ status: "error", message: "AI analysis service unavailable." });
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`System running on port ${PORT}.`));