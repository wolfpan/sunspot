const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

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

// 2. 全局通用请求头 (伪装浏览器)
const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*'
};

// 3. 数据抓取模块

// NOAA: 黑子数 & 射电流量
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
            console.log('[Sync] NOAA daily SSN & F10.7 saved directly.');
        }
    } catch (error) { console.error('[Error] NOAA SSN/F10.7:', error.message); }
}

// NOAA: Kp 指数 (精准适配大小写字段变体)
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
            
            // 核心修复：适配 {"time_tag":"...","Kp":2.33}
            if (latestData && latestData.time_tag !== undefined) {
                let timeStr = String(latestData.time_tag);
                if (!timeStr.includes('T')) timeStr = timeStr.replace(' ', 'T');
                if (!timeStr.endsWith('Z')) timeStr += 'Z';
                
                timestamp = new Date(timeStr).getTime();
                
                // 彻底兼容所有可能的 Kp 字段命名变体
                let rawKp = latestData.Kp !== undefined ? latestData.Kp : 
                            (latestData.kp !== undefined ? latestData.kp : latestData.Kp_index);
                kpVal = parseFloat(rawKp);
            } 
            // 兼容旧版二维数组格式
            else if (Array.isArray(latestData) && latestData.length >= 2) {
                const safeTimeStr = String(latestData[0]).replace(' ', 'T') + 'Z';
                timestamp = new Date(safeTimeStr).getTime();
                kpVal = parseFloat(latestData[1]);
            }
            
            // 确保解析出合法数字才入库
            if (timestamp && !isNaN(kpVal)) {
                insertMetric.run(timestamp, 'NOAA', 'kp_index', kpVal);
                console.log('[Sync] NOAA Kp index saved directly.');
                return;
            }
        }
        
        console.log('[Error] NOAA Kp: Parse failed. Snippet:', JSON.stringify(data).substring(0, 150));
    } catch (error) { 
        console.error('[Error] NOAA Kp:', error.message); 
    }
}

// SILSO: 黑子数
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

// ESA: 射电流量
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

// GFZ: Kp 指数
async function fetchGfzKpData() {
    try {
        const now = new Date();
        const endStr = encodeURIComponent(now.toISOString().split('.')[0] + 'Z');
        const startStr = encodeURIComponent(new Date(now.getTime() - 48 * 3600 * 1000).toISOString().split('.')[0] + 'Z');
        
        const url = `https://kp.gfz-potsdam.de/app/json/?start=${startStr}&end=${endStr}&index=Kp`;
        const response = await axios.get(url, { timeout: 10000 });
        const data = response.data;
        const lastIndex = data.datetime.length - 1;
        
        const timestamp = new Date(data.datetime[lastIndex]).getTime();
        insertMetric.run(timestamp, 'GFZ_POTSDAM', 'kp_index', data.Kp[lastIndex]);
        console.log('[Sync] GFZ Kp index saved.');
    } catch (error) { console.error('[Error] GFZ:', error.message); }
}

// 4. 定时调度机制
setTimeout(() => { 
    console.log('--- Initial Data Sync Started ---');
    fetchNoaaData(); 
    fetchNoaaKpData();
    fetchSilsoData(); 
    fetchGfzKpData();
    fetchEsaData();
}, 2000);

cron.schedule('0 1,13 * * *', () => {
    console.log('--- Scheduled Data Sync Started ---');
    fetchNoaaData();
    fetchNoaaKpData();
    fetchSilsoData();
    fetchGfzKpData();
    fetchEsaData();
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
                agency: row.source,
                metric: row.metric_type,
                value: row.value,
                record_time: new Date(row.timestamp).toISOString()
            }))
        });
    } catch (error) {
        res.status(500).json({ status: "error", message: "Database query failed" });
    }
});

// 6. 启动服务器
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`System running on port ${PORT}.`);
});