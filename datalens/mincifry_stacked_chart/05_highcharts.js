// ============================================================================
//  Вкладка «Оформление» (Highcharts) — стилистика Минцифры / Госуслуг.
//  Здесь разрешены функции, поэтому вся типографика, подписи и итоги — тут.
// ============================================================================

const BRAND = {
    blue: '#0D4CD3',
    blueDark: '#0B3D9E',
    red: '#EE3F58',
    green: '#0FA958',
    ink: '#0B1F33',
    muted: '#5A7196',
    grid: '#E4E8EE',
    axis: '#C9D2DE',
    bg: '#FFFFFF',
    panel: '#F5F7FA',
};

// Ubuntu — гарнитура дизайн-системы Госуслуг. Если её нет в инстансе DataLens,
// подхватится следующая из стека.
const FONT = "'Ubuntu', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// Пробел-разделитель разрядов (узкий неразрывный), формат «1 234».
function fmtNumber(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    const rounded = Math.round(Number(value) * 100) / 100;
    const parts = String(rounded).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts.join(',');
}

// Подпись внутри сегмента прячется, если сегмент меньше 6 % стека —
// иначе цифры налезают друг на друга на узких столбцах.
const MIN_LABEL_SHARE = 0.06;

module.exports = {
    chart: {
        type: 'column',
        backgroundColor: BRAND.bg,
        spacing: [28, 24, 16, 16],
        style: {fontFamily: FONT, color: BRAND.ink},
    },

    title: {
        text: 'Услуги по годам',
        align: 'left',
        margin: 24,
        style: {color: BRAND.ink, fontSize: '20px', fontWeight: '700', fontFamily: FONT},
    },

    subtitle: {
        text: 'Онлайн · Проактив · Рефакторинг, ед.',
        align: 'left',
        style: {color: BRAND.muted, fontSize: '13px', fontFamily: FONT},
    },

    xAxis: {
        lineColor: BRAND.axis,
        lineWidth: 1,
        tickColor: BRAND.axis,
        tickLength: 6,
        gridLineWidth: 0,
        labels: {
            style: {color: BRAND.muted, fontSize: '13px', fontFamily: FONT},
        },
        crosshair: {
            color: 'rgba(13, 76, 211, 0.06)',
            width: 48,
            zIndex: 0,
        },
    },

    yAxis: {
        title: {text: null},
        gridLineColor: BRAND.grid,
        gridLineDashStyle: 'Dash',
        lineWidth: 0,
        labels: {
            style: {color: BRAND.muted, fontSize: '12px', fontFamily: FONT},
            formatter: function () {
                return fmtNumber(this.value);
            },
        },
        // ⬇⬇ Суммы в итогах: значение всего стека над столбцом.
        stackLabels: {
            enabled: true,
            crop: false,
            overflow: 'allow',
            allowOverlap: false,
            y: -6,
            style: {
                color: BRAND.ink,
                fontSize: '13px',
                fontWeight: '700',
                fontFamily: FONT,
                textOutline: '2px #FFFFFF',
            },
            formatter: function () {
                return fmtNumber(this.total);
            },
        },
    },

    plotOptions: {
        column: {
            stacking: 'normal',
            borderWidth: 0,
            borderRadius: 2,
            groupPadding: 0.28,
            pointPadding: 0.02,
            maxPointWidth: 56,
            states: {
                hover: {brightness: 0.06},
                inactive: {opacity: 0.35},
            },
            dataLabels: {
                enabled: true,
                inside: true,
                crop: true,
                allowOverlap: false,
                style: {
                    color: '#FFFFFF',
                    fontSize: '12px',
                    fontWeight: '600',
                    fontFamily: FONT,
                    textOutline: 'none',
                },
                formatter: function () {
                    const total = this.point.stackTotal;
                    if (!this.y) return null;
                    if (total && Math.abs(this.y) / total < MIN_LABEL_SHARE) return null;
                    return fmtNumber(this.y);
                },
            },
        },
        line: {
            marker: {enabled: true, radius: 4},
        },
        series: {
            animation: {duration: 350},
        },
    },

    legend: {
        align: 'center',
        verticalAlign: 'bottom',
        symbolRadius: 6,
        symbolHeight: 10,
        symbolWidth: 10,
        itemDistance: 24,
        itemMarginTop: 8,
        itemStyle: {color: BRAND.ink, fontSize: '13px', fontWeight: '400', fontFamily: FONT},
        itemHoverStyle: {color: BRAND.blue},
        itemHiddenStyle: {color: '#A8B4C4'},
    },

    tooltip: {
        shared: true,
        useHTML: true,
        backgroundColor: '#FFFFFF',
        borderColor: BRAND.grid,
        borderRadius: 8,
        borderWidth: 1,
        shadow: {color: 'rgba(11, 31, 51, 0.12)', offsetX: 0, offsetY: 4, opacity: 1, width: 8},
        style: {color: BRAND.ink, fontSize: '13px', fontFamily: FONT},
        formatter: function () {
            const head = '<div style="font-weight:700;margin-bottom:6px">' + this.x + '</div>';
            let total = 0;
            const body = this.points.map(function (p) {
                if (p.series.type !== 'line') total += p.y;
                return '<div style="display:flex;gap:8px;align-items:center;line-height:20px">' +
                    '<span style="width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span>' +
                    '<span style="flex:1">' + p.series.name + '</span>' +
                    '<b>' + fmtNumber(p.y) + '</b></div>';
            }).join('');
            const foot = '<div style="margin-top:6px;padding-top:6px;border-top:1px solid ' + BRAND.grid +
                ';display:flex;gap:8px"><span style="flex:1">Всего услуг</span><b>' +
                fmtNumber(total) + '</b></div>';
            return head + body + foot;
        },
    },

    credits: {enabled: false},

    responsive: {
        rules: [{
            condition: {maxWidth: 600},
            chartOptions: {
                plotOptions: {column: {dataLabels: {enabled: false}}},
                legend: {itemDistance: 12, itemStyle: {fontSize: '12px'}},
                subtitle: {text: null},
            },
        }],
    },
};
