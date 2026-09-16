export const palettes = Object.freeze([
        // 依次为主色、强调色、高光、暗部；色值为参考视频后的设计近似。
        {code:'ORIGINAL',name:'杏霞',colors:['#FFB477','#F342B7','#FFF8F1','#C97965'],accentCut:.58,shadeStrength:.20,lightStrength:.78,label:'#A14770'},
        {code:'OCEAN',name:'蓝汐',colors:['#267DF5','#7951E9','#EFFBFF','#244A97'],accentCut:.59,shadeStrength:.31,lightStrength:.83,label:'#4867A5'},
        {code:'KLEIN',name:'钴焰',colors:['#153DC7','#E98036','#EAF0FF','#192033'],accentCut:.62,shadeStrength:.80,lightStrength:.43,label:'#955627'},
        {code:'ULTRAVIOLET',name:'紫萤',colors:['#9C80D5','#DFE764','#FAF7FF','#61517F'],accentCut:.64,shadeStrength:.30,lightStrength:.77,label:'#7658A4'},
        {code:'CHROME',name:'银雾',colors:['#A4AFBA','#38424F','#F7FAFC','#222B36'],accentCut:.58,shadeStrength:.65,lightStrength:.68,label:'#626D79'},
        {code:'PLUS',name:'落照',colors:['#FF8C52','#F64749','#FFF0CD','#A25336'],accentCut:.58,shadeStrength:.35,lightStrength:.82,label:'#A75136'},
        // 推荐试色：分别补充青绿、绛红、靛蓝香槟和深松绿。
        {code:'CELADON',name:'碧瓷',colors:['#278C83','#B8D8B4','#F2FAF5','#1D5855'],accentCut:.60,shadeStrength:.28,lightStrength:.76,label:'#286C62'},
        {code:'ROSE',name:'绛雪',colors:['#BD5275','#702D4F','#FFF5F7','#642C40'],accentCut:.63,shadeStrength:.36,lightStrength:.80,label:'#934362'},
        {code:'MOONSAND',name:'月砂',colors:['#343F74','#C7BA97','#F5F3EE','#202746'],accentCut:.65,shadeStrength:.48,lightStrength:.64,label:'#525C85'},
        {code:'PINE',name:'松影',colors:['#5B716A','#243E37','#F5F6EF','#172A24'],accentCut:.61,shadeStrength:.55,lightStrength:.70,label:'#466156'},
        // PalServerConsole: transparent clouds over the host theme surface.
        {code:'PAL_TIDE',name:'帕鲁海湾',colors:['#269AC4','#39BDAA','#B9E8E4','#24647D'],accentCut:.62,shadeStrength:.24,lightStrength:.40,label:'#3D6973',transparent:true},
        {code:'PAL_GROVE',name:'翠叶原野',colors:['#36A875','#8DCB87','#D0EBC6','#296B55'],accentCut:.65,shadeStrength:.24,lightStrength:.40,label:'#47705D',transparent:true},
        {code:'PAL_CORAL',name:'珊瑚余烬',colors:['#CB6560','#E69A73','#F4D6C3','#8B4747'],accentCut:.68,shadeStrength:.24,lightStrength:.36,label:'#A34C4A',transparent:true},
        {code:'PAL_MIST',name:'海岸薄雾',colors:['#809CA5','#A8BAB6','#D6E1DD','#536D76'],accentCut:.65,shadeStrength:.20,lightStrength:.38,label:'#686E6B',transparent:true},
].map((p, i) => Object.freeze({...p, colors: Object.freeze(p.colors), recommended: i >= 6})));
export function getPalette(code = "ORIGINAL") {
 const p = palettes.find(p => p.code === code);
 if (!p) throw new RangeError(`Unknown FlowMist palette: ${code}`);
 return p;
}
