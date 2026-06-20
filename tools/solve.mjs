import { SHAPES, AREA, ROLES } from './fig.mjs';
const U=60;
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
function wp(shape,[x,y,r]){const a=r*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return shape.map(([px,py])=>[x+px*c-py*s,y+px*s+py*c]);}
function inPoly(p,poly){ // ray cast
  let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];const hit=((yi>p[1])!==(yj>p[1]))&&(p[0]<(xj-xi)*(p[1]-yi)/(yj-yi)+xi);if(hit)inside=!inside;}return inside;
}
// unit triangles: each cell (i,j) split into 4 by center; key "i,j,d"
function triCentroid(i,j,d){const x=i*U,y=j*U,c=[x+U/2,y+U/2];
  const corners={S:[[x,y],[x+U,y]],E:[[x+U,y],[x+U,y+U]],N:[[x+U,y+U],[x,y+U]],W:[[x,y+U],[x,y]]}[d];
  return [(corners[0][0]+corners[1][0]+c[0])/3,(corners[0][1]+corners[1][1]+c[1])/3];
}
export function triSet(poly){ // all unit triangles whose centroid is inside poly
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;for(const[x,y]of poly){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  const set=new Set();
  for(let i=Math.floor(minX/U)-1;i<=Math.ceil(maxX/U)+1;i++)for(let j=Math.floor(minY/U)-1;j<=Math.ceil(maxY/U)+1;j++)for(const d of ['S','E','N','W']){const c=triCentroid(i,j,d);if(inPoly(c,poly))set.add(`${i},${j},${d}`);}
  return set;
}
const ROT={LT:[0,90,180,270],ST:[0,90,180,270],SQ:[0],PAR:[0,90,180,270],MT:[45,135,225,315]};
function footprint(shape,place,allTris){ // which target tris have centroid inside this placed piece
  const poly=wp(shape,place);const hit=[];
  for(const key of allTris){const [i,j,d]=key.split(',');const c=triCentroid(+i,+j,d);
    // strict inside
    let inside=true;for(let k=0;k<poly.length;k++){const a=poly[k],b=poly[(k+1)%poly.length];if(cross(sub(b,a),sub(c,a))< -1)inside=false;}
    if(inside)hit.push(key);}
  return hit;
}
export function solve(poly){
  const target=triSet(poly);
  if(target.size!==32){return {error:`target has ${target.size} triangles (need 32 = area 28800)`};}
  const tris=[...target];
  // bbox cells
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;for(const[x,y]of poly){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  const I0=Math.floor(minX/U)-2,I1=Math.ceil(maxX/U)+2,J0=Math.floor(minY/U)-2,J1=Math.ceil(maxY/U)+2;
  // precompute candidate placements per role: {place, cover:Set}
  const cands={};
  for(const [role,sh] of ROLES){cands[role]=[];const shape=SHAPES[sh];
    for(let i=I0;i<=I1;i++)for(let j=J0;j<=J1;j++)for(const r of ROT[sh]){
      const place=[i*U,j*U,r];const fp=footprint(shape,place,target);
      if(fp.length*900===AREA[sh]&&fp.length>0)cands[role].push({place,cover:new Set(fp)});
    }}
  const covered=new Set();const used={};const result={};
  function firstEmpty(){for(const t of tris)if(!covered.has(t))return t;return null;}
  function dfs(depth){
    if(depth===ROLES.length)return true;
    const t=firstEmpty();if(t===null)return false;
    for(const [role,sh] of ROLES){if(used[role])continue;
      for(const cand of cands[role]){if(!cand.cover.has(t))continue;let ok=true;for(const c of cand.cover)if(covered.has(c)){ok=false;break;}if(!ok)continue;
        used[role]=true;for(const c of cand.cover)covered.add(c);result[role]=cand.place;
        if(dfs(depth+1))return true;
        used[role]=false;for(const c of cand.cover)covered.delete(c);
      }}
    return false;
  }
  return dfs(0)?{fig:result}:{error:'no tiling found'};
}
