export const vertex = 'attribute vec2 a; varying vec2 uv; void main(){uv=a*.5+.5; gl_Position=vec4(a,0.,1.);}';
export const fragment = `
      precision highp float;
      varying vec2 uv;
      uniform float time, aspect, progress, detail;
      uniform vec3 baseColor,accentColor,lightColor,shadeColor;
      uniform float accentCut,shadeStrength,lightStrength;
      uniform float transparentBackground;
      float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
      float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
        mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
      float fbm(vec3 p){float n=0.;float a=.53;for(int i=0;i<4;i++){n+=a*noise(p);p=p*2.03+vec3(5.2,1.3,8.1);a*=.48;}return n;}
      mat2 turn(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
      vec3 warp(vec3 p){
        // 多个局部涡团以不同节奏翻转，每个涡团同时绕平面和纵深旋转。
        // 位移有界，避免持续平移或随时间越来越细的拉丝。
        vec3 displacement=vec3(0.);
        for(int j=0;j<4;j++){
          float k=float(j);
          vec3 center=vec3((.16+.23*k)*aspect*2.3,
            .34*sin(k*2.4+time*.19), .35*cos(k*1.7+time*.23));
          vec3 d=p-center;
          vec3 local=d*vec3(.68,.85,.58);
          float influence=exp(-dot(local,local)*.95);
          float direction=mod(k,2.)*2.-1.;
          float spin=direction*(1.25*sin(time*(.43+k*.047)+k*1.9)
            +.55*sin(time*.29+k*.8));
          vec3 curled=d;
          curled.yz=turn(.95*sin(time*.39+k*2.1))*curled.yz;
          curled.xy=turn(spin)*curled.xy;
          curled.xz=turn(.38*sin(time*.31+k*1.4))*curled.xz;
          float swell=1.+.14*sin(time*.57+k*2.3);
          displacement+=(curled*swell-d)*influence*.85;
        }
        p+=displacement;
        // 局部隆起与凹陷持续变化，前后层使用不同坐标，产生云团涌出和回卷。
        vec3 phase=vec3(.65*sin(time*.37),.55*cos(time*.27),.60*sin(time*.21));
        vec3 q=vec3(noise(p*.95+phase),
          noise(p*.95+vec3(5.2,1.3,2.8)-phase.yzx),
          noise(p*.95+vec3(1.7,9.2,4.5)+phase.zxy));
        p+=(q-.5)*mix(1.3,2.1,detail);
        p+=.22*vec3(sin(p.y*1.7+p.z+time*.55),
          sin(p.z*1.6-p.x*.8-time*.41),sin(p.x*1.1+p.y+time*.37));
        return p;
      }
      float field(vec3 p){return fbm(p*mix(1.6,2.7,detail));}
      void main(){
        vec2 xy=vec2(uv.x*aspect,uv.y-.5)*2.3;
        vec3 col=vec3(0.);float opacity=0.;
        // 大色团共享一个中间层的运动，避免不同纵深的互补色平均成灰。
        // 强调色与乳白云层各有独立的大尺度分布，细节只改变体积明暗。
        vec3 colorSpace=warp(vec3(xy,.2));
        vec3 broad=colorSpace*vec3(.42,.58,.12);
        float pigment=.80*noise(broad+vec3(2.2,5.7,1.4))
          +.20*noise(broad*1.8+vec3(7.8,2.1,4.5));
        float accent=smoothstep(accentCut-.055,accentCut+.045,pigment);
        vec3 pigmentColor=mix(baseColor,accentColor,accent);
        float veilField=.78*noise(colorSpace*vec3(.50,.65,.15)+vec3(8.4,3.2,6.1))
          +.22*noise(broad*1.6+vec3(1.2,7.5,3.6));
        float veil=smoothstep(.46,.74,veilField);
        // 端点附近收拢波动，使 0% 全空、100% 全满。
        float edgeActivity=smoothstep(0.,.08,progress)*(1.-smoothstep(.92,1.,progress));
        float roll=(sin(uv.y*5.5-time*.68)+.45*sin(uv.y*11.+time*.49))*.12/aspect;
        for(int i=0;i<12;i++){
          float z=1.6-float(i)*.28;
          vec3 p=warp(vec3(xy,z));
          float n=field(p);
          float density=smoothstep(.35,.65,n)*.48;
          // 每层云团都有自己的流动边缘，纹理直接参与推进和消散。
          float curl=(n-.48)*.70/aspect;
          float front=progress+edgeActivity*(roll+curl-z*z*.025/aspect);
          float feather=max(.0001,edgeActivity*(.065+.07*n)/aspect);
          float coverage=1.-smoothstep(front-feather,front+feather,uv.x);
          if(progress<=0.)coverage=0.;
          if(progress>=1.)coverage=1.;
          density*=coverage;
          float neighbor=field(p+vec3(-.15,.22,.16));
          float light=clamp((neighbor-n)*3.2+.68,.18,1.);
          // 暗部使用主题色，分别控制轻盈主题与浓重主题的对比。
          float shadow=smoothstep(.025,.20,n-neighbor)*shadeStrength;
          vec3 cloud=mix(pigmentColor,shadeColor,shadow);
          float milk=lightStrength*(.68*veil+.36*smoothstep(.66,.91,light)
            +.20*smoothstep(.58,.73,n));
          cloud=mix(cloud,lightColor,clamp(milk,0.,.84));
          col+=(1.-opacity)*cloud*density;
          opacity+=(1.-opacity)*density;
        }
        if(transparentBackground>.5){
          // Keep the cloud pigment; let CSS supply the light/island/dark track.
          float fade=.22+.78*smoothstep(.0,.30,uv.x);
          gl_FragColor=vec4(pow(clamp(col/max(opacity,.0001),0.,1.),vec3(.94)),opacity*fade);
          return;
        }
        col+=(1.-opacity)*vec3(.997);
        col=pow(col,vec3(.94));
        float leftFade=.06+.94*smoothstep(.18,.45,uv.x);
        col=mix(vec3(.997),col,leftFade);
        gl_FragColor=vec4(clamp(col,0.,1.),1.);
      }`;
