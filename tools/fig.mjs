import { writeFileSync } from 'fs';
const SQRT2=Math.sqrt(2);
export const SHAPES={
  LT:[[0,0],[120,0],[0,120]],
  MT:[[0,0],[60*SQRT2,0],[0,60*SQRT2]],
  ST:[[0,0],[60,0],[0,60]],
  SQ:[[0,0],[60,0],[60,60],[0,60]],
  PAR:[[0,0],[60,0],[120,60],[60,60]],
};
export const AREA={LT:7200,MT:3600,ST:1800,SQ:3600,PAR:3600};
const COLORS={LT1:'#c64a2e',LT2:'#e08a3c',MT:'#3aa0d8',SQ:'#d83fa0',PAR:'#7a52d8',ST1:'#3ab85a',ST2:'#e6c33a'};
// roles: a figure assigns each of the 7 roles a placement [x,y,rot]
export const ROLES=[['LT1','LT'],['LT2','LT'],['MT','MT'],['SQ','SQ'],['PAR','PAR'],['ST1','ST'],['ST2','ST']];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
function wp(shape,[x,y,r]){const a=r*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return shape.map(([px,py])=>[x+px*c-py*s,y+px*s+py*c]);}
function axes(p){return p.map((pt,i)=>{const n=p[(i+1)%p.length];const dx=n[0]-pt[0],dy=n[1]-pt[1];const l=Math.hypot(dx,dy)||1;return[-dy/l,dx/l];});}
function overlap(a,b,eps=0.5){for(const ax of[...axes(a),...axes(b)]){const pa=a.map(([x,y])=>x*ax[0]+y*ax[1]);const pb=b.map(([x,y])=>x*ax[0]+y*ax[1]);if(Math.max(...pa)<=Math.min(...pb)+eps||Math.max(...pb)<=Math.min(...pa)+eps)return false;}return true;}
const touch=(a,b)=>overlap(a,b,-0.9);
export function validate(fig){
  const polys=ROLES.map(([role,sh])=>wp(SHAPES[sh],fig[role]));
  const bad=[];
  for(let i=0;i<polys.length;i++)for(let j=i+1;j<polys.length;j++)if(overlap(polys[i],polys[j]))bad.push(ROLES[i][0]+'/'+ROLES[j][0]);
  // connectivity
  const seen=new Set([0]),st=[0];while(st.length){const c=st.pop();for(let k=0;k<polys.length;k++){if(seen.has(k))continue;if(touch(polys[c],polys[k])){seen.add(k);st.push(k);}}}
  const connected=seen.size===polys.length;
  return {overlaps:bad,connected};
}
export function render(figs,cols,file){
  // figs: array of {name, fig}; lay out in a grid
  const cell=300,pad=24;
  const rows=Math.ceil(figs.length/cols);
  const W=cols*cell, H=rows*cell;
  let body='';
  figs.forEach((F,idx)=>{
    const gx=(idx%cols)*cell, gy=Math.floor(idx/cols)*cell;
    // compute bbox
    const polys=ROLES.map(([role,sh])=>wp(SHAPES[sh],F.fig[role]));
    let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
    for(const p of polys)for(const [x,y] of p){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    const w=maxX-minX,h=maxY-minY,sc=Math.min((cell-2*pad)/w,(cell-2*pad)/h);
    const ox=gx+pad+((cell-2*pad)-w*sc)/2-minX*sc, oy=gy+pad+((cell-2*pad)-h*sc)/2-minY*sc;
    body+=`<rect x="${gx}" y="${gy}" width="${cell}" height="${cell}" fill="white" stroke="#bbb"/>`;
    ROLES.forEach(([role,sh],i)=>{
      const pts=polys[i].map(([x,y])=>`${(ox+x*sc).toFixed(1)},${(oy+y*sc).toFixed(1)}`).join(' ');
      body+=`<polygon points="${pts}" fill="${COLORS[role]}" stroke="#fff" stroke-width="1"/>`;
    });
    body+=`<text x="${gx+8}" y="${gy+18}" font-family="sans-serif" font-size="13" fill="#333">${F.name}</text>`;
  });
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="white"/>${body}</svg>`;
  writeFileSync(file,svg);
  return file;
}
