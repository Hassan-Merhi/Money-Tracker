import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const EXCLUDED_DIRS=new Set(['.git','.github','data','docs','node_modules','scripts','tests']);
const BROWSER_EXTENSIONS=new Set(['.html','.css','.js','.webmanifest','.svg','.png','.ico']);

function walk(dir,root,out){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    if(entry.isDirectory()){
      if(EXCLUDED_DIRS.has(entry.name))continue;
      walk(join(dir,entry.name),root,out);
      continue;
    }
    if(!entry.isFile()||!BROWSER_EXTENSIONS.has(extname(entry.name)))continue;
    out.push(join(dir,entry.name));
  }
  return out;
}

export function browserAssetFiles(root){
  return walk(root,root,[]).sort((a,b)=>relative(root,a).localeCompare(relative(root,b)));
}

export function computeAssetVersion(root){
  const hash=createHash('sha256');
  const files=browserAssetFiles(root);
  if(!files.length)throw new Error('No browser assets found for release fingerprint.');
  for(const file of files){
    hash.update(relative(root,file).replaceAll('\\','/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0,12);
}

function versioned(path,version){
  return `${path}?v=${encodeURIComponent(version)}`;
}

export function stampHtmlAssets(source,version){
  let out=String(source).replaceAll('__ASSET_VERSION__',version);
  out=out.replace(/((?:src|href)=["'])(\.\/[^"'?#]+\.(?:js|css|svg|png|ico))(?:\?[^"']*)?(["'])/g,(_,prefix,path,suffix)=>`${prefix}${versioned(path,version)}${suffix}`);
  return out;
}

export function stampModuleImports(source,version){
  let out=String(source);
  const apply=(regex)=>{out=out.replace(regex,(_,prefix,path,suffix)=>`${prefix}${versioned(path,version)}${suffix}`);};
  apply(/(\bfrom\s+["'])(\.\.?\/[^"'?#]+\.js)(?:\?[^"']*)?(["'])/g);
  apply(/(\bimport\s+["'])(\.\.?\/[^"'?#]+\.js)(?:\?[^"']*)?(["'])/g);
  apply(/(\bimport\s*\(\s*["'])(\.\.?\/[^"'?#]+\.js)(?:\?[^"']*)?(["']\s*\))/g);
  return out;
}

export function stampServiceWorker(source,version){
  return String(source).replaceAll('__ASSET_VERSION__',version);
}
