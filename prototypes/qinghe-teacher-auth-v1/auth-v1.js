/*
 * 青禾老师账号体验 V1.0 完整原型层。
 * 该文件覆盖单文件原型中的旧账号函数，模拟 PRD 的状态机、会话撤销、
 * 登录前动作恢复、工作区准备及幂等重试。生产环境必须替换为 IAM/API/Keycloak。
 */
(function(){
  'use strict';

  const KEY={
    users:'teacher-auth-users',session:'teacher-auth-session',email:'teacher-auth-email',nickname:'teacher-auth-nickname',
    sessionMeta:'teacher-auth-session-meta',sessionRevision:'teacher-auth-session-revision',workspace:'teacher-workspace-state-v1',
    reg:'qinghe-auth-registration-session',regLast:'qinghe-auth-registration-last',resetRequest:'qinghe-auth-reset-request',resetSession:'qinghe-auth-reset-session',
    pending:'qinghe-auth-pending',pendingFailure:'qinghe-auth-pending-failure',view:'qinghe-auth-view',agreements:'teacher-auth-agreements',registrationResults:'teacher-auth-registration-results'
  };
  const TTL={pending:2*60*60*1000,registration:15*60*1000,code:10*60*1000,resetLink:30*60*1000,resetSession:10*60*1000,idle:7*24*60*60*1000,absolute:30*24*60*60*1000};
  const AGREEMENT_VERSIONS={terms:'2026-09-01',privacy:'2026-09-01'};
  const IDEMPOTENCY_TTL=24*60*60*1000;
  const IDEMPOTENCY_KEY='teacher-auth-idempotency-results';
  let resumeConfirmation=null,retryAction=null,workspaceTimer=null,logoutBusy=false,csrfToken='';

  function now(){return Date.now();}
  function read(storage,key,fallback=null){try{const raw=storage.getItem(key);return raw==null?fallback:JSON.parse(raw);}catch(_){return fallback;}}
  function write(storage,key,value){try{storage.setItem(key,JSON.stringify(value));return true;}catch(_){return false;}}
  function remove(storage,key){try{storage.removeItem(key);}catch(_){}}
  function uuid(prefix){const id=globalThis.crypto?.randomUUID?.()||now().toString(36)+'_'+Math.random().toString(36).slice(2);return prefix+'_'+id;}
  function userId(email){return String(email||'').trim().toLowerCase();}
  function getSessionRevision(){return Number(localStorage.getItem(KEY.sessionRevision)||0);}
  function bumpSessionRevision(){const value=getSessionRevision()+1;localStorage.setItem(KEY.sessionRevision,String(value));return value;}
  function currentWorkspace(){return read(localStorage,KEY.workspace,{status:'absent',updatedAt:now()});}
  function saveWorkspace(state){write(localStorage,KEY.workspace,{...state,updatedAt:now()});}
  function activeGate(){return document.getElementById('authGate')?.classList.contains('show');}
  function currentNodeId(){try{return String((typeof cur!=='undefined'&&cur)||(typeof curFam!=='undefined'&&curFam)||'');}catch(_){return '';}}
  function currentWorkspaceMode(){try{return String(typeof mode!=='undefined'?mode:'');}catch(_){return '';}}
  function issueCsrfToken(){csrfToken=uuid('csrf');return csrfToken;}
  function getCsrfToken(){return csrfToken||issueCsrfToken();}
  function setOverlay(id,open){const el=document.getElementById(id);if(!el)return;el.classList.toggle('show',open);el.setAttribute('aria-hidden',String(!open));}
  function setBusy(button,busy,label){if(!button)return;if(busy){button.dataset.prdIdle=button.textContent;button.disabled=true;button.classList.add('is-loading');button.textContent=label;}else{button.disabled=false;button.classList.remove('is-loading');button.textContent=button.dataset.prdIdle||label||button.textContent;delete button.dataset.prdIdle;}}
  function focusSoon(id){setTimeout(()=>document.getElementById(id)?.focus(),30);}
  function safeText(value){return String(value||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  function serializableArgs(args){return Array.from(args||[]).map(value=>{if(value==null||['string','number','boolean'].includes(typeof value))return value;if(value instanceof Element)return {elementId:value.id||'',elementClass:value.className||''};return null;});}

  function getUsers(){return read(localStorage,KEY.users,{});}
  function saveUsers(users){write(localStorage,KEY.users,users);}
  function getCurrentEmail(){return (localStorage.getItem(KEY.email)||'').trim().toLowerCase();}
  function sessionState(touch=true){
    try{
      if(localStorage.getItem(KEY.session)!=='1'||!getCurrentEmail())return {active:false,reason:localStorage.getItem('teacher-auth-session-ended-reason')||'guest'};
      const meta=read(localStorage,KEY.sessionMeta,null),time=now();
      if(!meta){createSession(getCurrentEmail());return {active:true};}
      if(meta.revision!==getSessionRevision()||time>=meta.absoluteExpiresAt||time>=meta.idleExpiresAt){
        const reason=meta.revision!==getSessionRevision()?'revoked':time>=meta.absoluteExpiresAt?'absolute-expired':'idle-expired';
        clearSession(reason,false);return {active:false,reason};
      }
      if(touch&&time-(meta.lastSeenAt||0)>5*60*1000){meta.lastSeenAt=time;meta.idleExpiresAt=Math.min(meta.absoluteExpiresAt,time+TTL.idle);write(localStorage,KEY.sessionMeta,meta);}
      return {active:true,meta};
    }catch(_){return {active:false,reason:'storage-error'};}
  }
  function createSession(email){
    const time=now(),revision=getSessionRevision(),account=getUsers()[userId(email)]||{},token=issueCsrfToken();
    localStorage.setItem(KEY.session,'1');localStorage.setItem(KEY.email,userId(email));localStorage.removeItem('teacher-auth-session-ended-reason');
    write(localStorage,KEY.sessionMeta,{id:uuid('ses'),email:userId(email),tenantId:account.tenantId||'tenant_'+userId(email),revision,createdAt:time,lastSeenAt:time,idleExpiresAt:time+TTL.idle,absoluteExpiresAt:time+TTL.absolute});
  }
  function clearSession(reason='expired',revoke=false){
    if(revoke)bumpSessionRevision();
    csrfToken='';
    localStorage.removeItem(KEY.session);remove(localStorage,KEY.sessionMeta);localStorage.setItem('teacher-auth-session-ended-reason',reason);
  }
  function ensureAuthenticated(action,title,copy,meta={}){
    const state=sessionState();
    if(state.active){getCsrfToken();return true;}
    if(state.reason&&state.reason!=='guest'&&state.reason!=='logout'){
      if(meta.originUserId===undefined)meta.originUserId=getCurrentEmail();
      meta.sessionExpiredReason=state.reason;
    }
    globalThis.pendingAuthAction=action;
    savePending(title,copy,meta);
    openGate('authMainState');
    const help=document.getElementById('authMainHelp');
    if(help&&meta.sessionExpiredReason)help.textContent='登录状态已过期，请重新登录。';
    return false;
  }

  function pendingContext(){const value=read(sessionStorage,KEY.pending,null);return value&&typeof value==='object'?value:null;}
  function validPending(context){return !!context&&Number.isFinite(context.createdAt)&&now()>=context.createdAt&&now()-context.createdAt<=TTL.pending;}
  function savePending(title,copy,meta={}){
    const previous=pendingContext(),input=document.getElementById('input'),activeTask=document.querySelector('.tree-task.on');
    const context={
      pendingActionId:meta.pendingActionId||previous?.pendingActionId||uuid('pa'),
      originUserId:meta.originUserId!==undefined?meta.originUserId:(sessionState(false).active?getCurrentEmail():''),
      actionType:meta.actionType||'resume-action',taskName:meta.taskName||input?.value?.trim()||title,message:meta.message??(input?.value?.trim()||''),
      uploadIntent:!!meta.uploadIntent,actionArgs:Array.isArray(meta.actionArgs)?meta.actionArgs:[],projectId:meta.projectId||activeTask?.dataset.folderRef||'',projectTaskId:meta.projectTaskId||activeTask?.dataset.taskId||'',
      projectName:meta.projectName||activeTask?.querySelector('.tree-task-label')?.textContent?.trim()||'',nodeId:meta.nodeId||currentNodeId(),
      workspaceMode:meta.workspaceMode||currentWorkspaceMode(),title,copy,createdAt:meta.createdAt||now(),attempts:Number(meta.attempts||previous?.attempts||0),
      confirmed:!!meta.confirmed,requestDigest:meta.requestDigest||[meta.actionType||'resume-action',meta.taskName||'',input?.value?.trim()||'',JSON.stringify(Array.isArray(meta.actionArgs)?meta.actionArgs:[])].join('|')
    };
    write(sessionStorage,KEY.pending,context);return context;
  }
  function clearPending(){remove(sessionStorage,KEY.pending);remove(sessionStorage,KEY.pendingFailure);globalThis.pendingAuthAction=null;}
  function restoreContext(context){
    if(!context)return;
    const input=document.getElementById('input');if(input&&context.message&&!input.value)input.value=context.message;
    const task=context.projectTaskId?document.querySelector('.tree-task[data-task-id="'+CSS.escape(context.projectTaskId)+'"]'):null;
    if(task&&typeof globalThis.swProj==='function')globalThis.swProj(task,context.projectName||task.querySelector('.tree-task-label')?.textContent||'当前任务');
    if(context.workspaceMode&&['rel','task','prod'].includes(context.workspaceMode)&&typeof globalThis.setMode==='function')globalThis.setMode(context.workspaceMode);
    if(context.nodeId&&typeof FAM!=='undefined'&&FAM[context.nodeId]&&typeof globalThis.pickFam==='function')globalThis.pickFam(context.nodeId,false);
    else if(context.nodeId&&typeof N!=='undefined'&&N[context.nodeId]&&typeof globalThis.pickAtom==='function')globalThis.pickAtom(context.nodeId);
    else if(context.nodeId&&typeof globalThis.selectTaskNode==='function')globalThis.selectTaskNode(context.nodeId);
  }
  function idempotencyResults(){
    const all=read(localStorage,IDEMPOTENCY_KEY,{}),time=now();
    Object.keys(all).forEach(key=>{if(time-(all[key].createdAt||0)>IDEMPOTENCY_TTL)delete all[key];});write(localStorage,IDEMPOTENCY_KEY,all);return all;
  }
  function actionAccepted(context){const all=idempotencyResults(),key=getCurrentEmail()+'|'+context.actionType+'|'+context.pendingActionId,result=all[key];return result&&result.requestDigest===context.requestDigest;}
  function recordAccepted(context){const all=idempotencyResults(),key=getCurrentEmail()+'|'+context.actionType+'|'+context.pendingActionId;all[key]={requestDigest:context.requestDigest,createdAt:now()};write(localStorage,IDEMPOTENCY_KEY,all);}
  function registrationResults(){return read(localStorage,KEY.registrationResults,{});}
  function saveRegistrationResult(session,account){const result={sessionId:session.id,userId:account.email,tenantId:account.tenantId,idempotencyKey:session.idempotencyKey,createdAt:now()};const all=registrationResults();all[session.idempotencyKey]=result;write(localStorage,KEY.registrationResults,all);write(sessionStorage,KEY.regLast,result);}
  function actionFor(context){
    if(globalThis.pendingAuthAction)return globalThis.pendingAuthAction;
    if(context.actionType==='send-message')return ()=>globalThis.ask?.('custom');
    if(context.actionType==='create-project')return ()=>{const field=document.getElementById('newProjectName');if(field)field.value=context.taskName||field.value;globalThis.createProject?.();};
    if(context.actionType==='confirm-prep')return ()=>globalThis.confirmPrepConfirmation?.();
    if(context.actionType==='save-draft')return ()=>globalThis.saveArtifactEdit?.(context.nodeId||currentNodeId());
    if(context.actionType==='deliver-artifact')return ()=>globalThis.deliverArtifact?.(...(context.actionArgs||[]));
    if(context.actionType==='confirm-memory')return ()=>globalThis.confirmMemory?.(...(context.actionArgs||[]));
    if(context.actionType==='confirm-inference')return ()=>globalThis.confirmInference?.(Array.from(document.querySelectorAll('.profile-card')).find(el=>el.textContent.includes('推测 · 等待确认'))?.querySelector('button'));
    if(context.actionType==='confirm-upgrade')return ()=>globalThis.confirmUpgrade?.(...(context.actionArgs||[]));
    if(context.actionType==='save-automation')return ()=>globalThis.saveTeacherAutomation?.(...(context.actionArgs||[]));
    if(context.actionType==='add-calendar-lesson')return ()=>globalThis.addCalendarLesson?.(...(context.actionArgs||[]));
    if(context.actionType==='archive-folder')return ()=>globalThis.archiveFolder?.(...(context.actionArgs||[]));
    if(context.actionType==='archive-task')return ()=>globalThis.archiveTask?.(...(context.actionArgs||[]));
    if(context.actionType==='rename-item')return ()=>globalThis.renameWorkspaceItem?.(...(context.actionArgs||[]));
    if(context.actionType==='generate-artifact')return ()=>globalThis.generateArtifact?.(...(context.actionArgs||[]));
    return null;
  }
  function showResumeConfirm(context,action){
    resumeConfirmation={context,action};
    document.getElementById('authResumeConfirmTitle').textContent=context.actionType==='confirm-prep'?'确认备课信息并创建任务？':'确认继续刚才的操作？';
    document.getElementById('authResumeConfirmCopy').textContent='已恢复页面和临时内容。该操作会确认、覆盖或写入已有内容，请再次确认后继续。';
    setOverlay('ovAuthResumeConfirm',true);focusSoon('authResumeConfirmButton');
  }
  function failResume(context,action,error){
    const next={...context,attempts:Number(context.attempts||0)+1,lastError:String(error?.message||error||'unknown'),createdAt:context.createdAt};
    write(sessionStorage,KEY.pending,next);write(sessionStorage,KEY.pendingFailure,{pendingActionId:next.pendingActionId,failedAt:now()});retryAction=action;
    document.getElementById('authRetryCopy').textContent='安全的临时内容仍已保留。重新执行会复用操作标识 '+next.pendingActionId+'，不会重复创建任务。';
    setOverlay('ovAuthRetry',true);focusSoon('authRetryButton');
  }
  function executePending(context,action,automatic=true){
    if(actionAccepted(context)){clearPending();toast('该操作已经处理，无需重复执行');return;}
    try{
      if(globalThis.__AUTH_TEST_FAIL_NEXT_ACTION__){globalThis.__AUTH_TEST_FAIL_NEXT_ACTION__=false;throw new Error('模拟网络失败');}
      if(!action){clearPending();return;}
      const result=action();
      Promise.resolve(result).then(()=>{recordAccepted(context);clearPending();}).catch(error=>failResume(context,action,error));
    }catch(error){
      if(automatic&&Number(context.attempts||0)<1){const retried={...context,attempts:Number(context.attempts||0)+1};write(sessionStorage,KEY.pending,retried);setTimeout(()=>executePending(retried,action,false),160);return;}
      failResume(context,action,error);
    }
  }
  function resumePending(){
    const context=pendingContext(),action=actionFor(context||{});globalThis.pendingAuthAction=null;
    if(!context)return;
    if(!validPending(context)){clearPending();toast('登录成功，但原操作已超过 2 小时，请重新发起');return;}
    if(context.originUserId&&context.originUserId!==getCurrentEmail()){clearPending();toast('登录账号与原操作账号不一致，未继续执行');return;}
    restoreContext(context);
    if(context.uploadIntent||context.actionType==='upload-file'){clearPending();toast('登录状态已恢复，请重新选择要上传的文件');return;}
    if(context.actionType==='confirm-prep'||context.confirmed){showResumeConfirm(context,action);return;}
    toast(context.taskName?'已登录，正在继续创建“'+context.taskName+'”':'已登录，正在继续刚才的操作');
    setTimeout(()=>executePending(context,action,true),120);
  }

  function renderWorkspace(status){
    const mark=document.getElementById('authWorkspaceStatusMark'),title=document.getElementById('authWorkspaceStatusTitle'),copy=document.getElementById('authWorkspaceStatusCopy'),button=document.getElementById('authWorkspaceReadyButton');
    if(!mark||!button)return;
    button.dataset.workspaceAction=status;
    if(status==='ready'){globalThis.authWorkspaceProvisioning=false;mark.textContent='✓';title.textContent='注册成功';copy.textContent='个人备课空间和默认工作区已准备好，可以继续刚才的操作。';button.disabled=false;button.textContent='进入个人备课空间';}
    else if(status==='failed'){globalThis.authWorkspaceProvisioning=false;mark.textContent='!';title.textContent='空间准备遇到问题';copy.textContent='账号和个人租户已经创建。请重新检查工作区状态，后台补偿不会重复占用邀请码。';button.disabled=false;button.textContent='重新检查';}
    else{globalThis.authWorkspaceProvisioning=true;mark.textContent='…';title.textContent='正在准备个人备课空间';copy.textContent='账号和个人租户已创建，正在异步准备默认工作区。';button.disabled=true;button.textContent='正在准备…';}
  }
  function startWorkspaceProvisioning(retry=false){
    clearTimeout(workspaceTimer);saveWorkspace({status:'initializing',attempts:Number(currentWorkspace().attempts||0)+(retry?1:0),startedAt:now()});renderWorkspace('initializing');showState('authFirstRunState');
    workspaceTimer=setTimeout(()=>{
      const fail=localStorage.getItem('teacher-workspace-force-fail')==='1';saveWorkspace({status:fail?'failed':'ready',attempts:Number(currentWorkspace().attempts||0),startedAt:currentWorkspace().startedAt});renderWorkspace(fail?'failed':'ready');
    },1100);
  }

  function openGate(state='authMainState'){
    globalThis.authLastFocusedElement=document.activeElement;document.body.classList.add('auth-locked');
    const gate=document.getElementById('authGate');gate.classList.add('show');gate.setAttribute('aria-hidden','false');gate.scrollTop=0;showState(state);
    let context=pendingContext();if(context&&!validPending(context)){context=null;clearPending();toast('登录待办已超过 2 小时，请重新发起操作');}
    const intent=document.getElementById('authIntent');intent.classList.toggle('show',!!context);
    if(context){document.getElementById('authIntentTitle').textContent=context.title||'登录后继续刚才的操作';document.getElementById('authIntentCopy').textContent=context.copy||'你输入的内容已临时保留。';restoreContext(context);}
    const reason=localStorage.getItem('teacher-auth-session-ended-reason'),help=document.getElementById('authMainHelp');
    if(state==='authMainState'&&['idle-expired','absolute-expired','revoked'].includes(reason))help.textContent='登录状态已过期，请重新登录。';
  }
  function closeGate(keepPending=false){
    if(globalThis.authWorkspaceProvisioning&&!keepPending){toast('个人备课空间正在准备，请稍候');return;}
    document.body.classList.remove('auth-locked');const gate=document.getElementById('authGate');gate.classList.remove('show');gate.setAttribute('aria-hidden','true');
    ['authLoginConsent','authRegisterConsent'].forEach(id=>{const el=document.getElementById(id);if(el)el.checked=false;});
    ['authPassword','authRegisterPassword','authRegisterConfirm','authResetPassword','authResetConfirm'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    remove(sessionStorage,KEY.view);if(!keepPending)clearPending();setTimeout(()=>globalThis.authLastFocusedElement?.focus?.(),0);
  }
  function showState(id){
    document.querySelectorAll('.auth-state').forEach(el=>el.classList.toggle('on',el.id===id));document.getElementById('authWindow').classList.toggle('register-view',id==='authRegisterState');clearAuthErrors();document.getElementById('authGate').scrollTop=0;
    const stored=getCurrentEmail(),login=document.getElementById('authEmail'),register=document.getElementById('authRegisterEmail'),reset=document.getElementById('authResetEmail');
    if(id==='authMainState')login.value=stored||register.value.trim()||login.value;
    if(id==='authRegisterState'){if(!register.value)register.value=login.value;const reg=registrationSession();showRegistrationStep(reg&&registrationMatches(reg)?2:1);}
    if(id==='authResetState'){if(!reset.value)reset.value=login.value||stored;const view=read(sessionStorage,KEY.view,{});showReset(view.state==='authResetState'&&view.resetStep?view.resetStep:'authResetRequestStep');}
    if(id==='authFirstRunState')renderWorkspace(currentWorkspace().status||'initializing');
    if(!['authRegisterState','authResetState'].includes(id))write(sessionStorage,KEY.view,{state:id});
    const focus=id==='authRegisterState'?(document.getElementById('authRegisterStep2').classList.contains('on')?'authRegisterNickname':'authRegisterEmail'):id==='authResetState'?'authResetEmail':id==='authMainState'?'authEmail':'';if(focus)focusSoon(focus);
  }
  function showReset(id){document.querySelectorAll('#authResetState .auth-reset-step').forEach(el=>el.classList.toggle('on',el.id===id));clearAuthErrors(document.getElementById('authResetState'));write(sessionStorage,KEY.view,{state:'authResetState',resetStep:id});}

  function registrationSession(){const session=read(sessionStorage,KEY.reg,null);if(!session||session.status!=='verified'||now()>=session.expiresAt){if(session)clearRegistration();return null;}return session;}
  function registrationMatches(session){return !!session&&session.email===document.getElementById('authRegisterEmail')?.value.trim().toLowerCase()&&session.invite===document.getElementById('authInviteCode')?.value.trim();}
  function clearRegistration(){remove(sessionStorage,KEY.reg);clearInterval(globalThis.authRegisterSessionTicker);globalThis.authRegisterSessionTicker=null;globalThis.syncRegisterNextState?.();}
  function showRegistrationStep(step){
    globalThis.ensureRegisterStep2Header?.();const session=registrationSession();if(step===2&&(!session||!registrationMatches(session))){step=1;document.getElementById('authRegisterStep1Help').textContent='邮箱验证已失效，请重新验证。';}
    document.getElementById('authRegisterStep1').classList.toggle('on',step===1);document.getElementById('authRegisterStep2').classList.toggle('on',step===2);write(sessionStorage,KEY.view,{state:'authRegisterState',registerStep:step});
    if(step===2&&session){document.getElementById('authRegisterVerifiedEmail').textContent=globalThis.maskAuthEmail(session.email);clearInterval(globalThis.authRegisterSessionTicker);globalThis.updateRegisterSessionMeta?.();globalThis.authRegisterSessionTicker=setInterval(()=>{if(!registrationSession()){document.getElementById('authRegisterPassword').value='';document.getElementById('authRegisterConfirm').value='';showRegistrationStep(1);document.getElementById('authRegisterStep1Help').textContent='验证状态已超过 15 分钟，请重新验证邮箱。';}else globalThis.updateRegisterSessionMeta?.();},1000);}
    focusSoon(step===1?'authRegisterEmail':'authRegisterNickname');
  }
  function backToRegistrationStep1(){clearRegistration();globalThis.invalidateRegisterCode?.();document.getElementById('authRegisterPassword').value='';document.getElementById('authRegisterConfirm').value='';document.getElementById('authRegisterConsent').checked=false;showRegistrationStep(1);}
  function agreements(){return read(localStorage,KEY.agreements,[]);}
  function recordAgreement(scene,email){const list=agreements();list.push({userId:userId(email),scene,versions:AGREEMENT_VERSIONS,acceptedAt:new Date().toISOString()});write(localStorage,KEY.agreements,list.slice(-50));}

  async function login(){
    const email=document.getElementById('authEmail').value.trim().toLowerCase(),password=document.getElementById('authPassword').value,help=document.getElementById('authMainHelp'),button=document.getElementById('authEmailButton');help.textContent='';if(button.disabled)return;
    if(!globalThis.validateLoginField('authEmail',true)){help.textContent='请输入正确的邮箱地址。';globalThis.markAuthInvalid('authEmail');return;}
    if(!globalThis.validateLoginField('authPassword',true)){help.textContent='请输入至少 8 位密码。';globalThis.markAuthInvalid('authPassword');return;}
    if(!document.getElementById('authLoginConsent').checked){help.textContent='请先阅读并同意《用户协议》和《隐私政策》。';return;}
    setBusy(button,true,'登录中…');try{await globalThis.delay(340);const account=getUsers()[email];if(!account){help.textContent='该邮箱尚未注册，请先创建账号。';globalThis.markAuthInvalid('authEmail');return;}if(await globalThis.passwordDigest(password)!==account.passwordHash){help.textContent='密码不正确，请重新输入。';globalThis.markAuthInvalid('authPassword');return;}recordAgreement('login',email);finishAuth(email,false,account.nickname);}catch(_){help.textContent='登录失败，请稍后重试。你填写的内容已保留。';}finally{setBusy(button,false,'登录');}
  }
  async function register(){
    const button=document.getElementById('authRegisterButton');if(button.disabled)return;
    const data=globalThis.validateRegisterForm();if(!data)return;
    const session=registrationSession();if(!session||!registrationMatches(session)){data.help.textContent='邮箱验证已过期，请返回第一步重新验证。';return;}
    setBusy(button,true,'注册中…');try{await globalThis.delay(450);const users=getUsers();
      if(users[data.email]&&users[data.email].registrationSessionId===session.id&&users[data.email].idempotencyKey===session.idempotencyKey){finishAuth(data.email,true,users[data.email].nickname);return;}
      if(users[data.email]){data.help.textContent='该邮箱已注册，请返回登录。';return;}
      const passwordHash=await globalThis.passwordDigest(data.password),account={email:data.email,passwordHash,nickname:data.nickname,tenantId:'tenant_'+uuid('personal'),createdAt:now(),registrationSessionId:session.id,idempotencyKey:session.idempotencyKey,status:'active'};users[data.email]=account;saveUsers(users);saveRegistrationResult(session,account);session.status='consumed';session.userId=data.email;write(sessionStorage,KEY.reg,session);recordAgreement('register',data.email);finishAuth(data.email,true,data.nickname);
    }catch(_){data.help.textContent='注册失败，请稍后重试。已填写内容不会被清空。';}finally{setBusy(button,false,'完成注册');}
  }
  function finishAuth(email,isNew,nickname){
    createSession(email);issueCsrfToken();localStorage.setItem('teacher-auth-method','email');localStorage.setItem(KEY.nickname,nickname||'个人账号');
    ['authPassword','authRegisterPassword','authRegisterConfirm','authRegisterCode'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});clearRegistration();remove(sessionStorage,KEY.view);globalThis.syncAuthUI();
    if(isNew){startWorkspaceProvisioning(false);return;}const workspace=currentWorkspace();if(workspace.status==='initializing'||workspace.status==='failed'){showState('authFirstRunState');return;}closeGate(true);resumePending();
  }
  async function requestReset(fromLinkStep=false){
    const input=document.getElementById('authResetEmail'),email=(fromLinkStep?globalThis.authResetEmailValue:input.value.trim().toLowerCase()),help=document.getElementById('authResetHelp'),button=fromLinkStep?document.getElementById('authResetResendButton'):document.getElementById('authResetButton');if(!globalThis.validEmail(email)){help.textContent='请输入正确的邮箱地址。';globalThis.markAuthInvalid('authResetEmail');return;}if(button.disabled)return;
    setBusy(button,true,'发送中…');try{await globalThis.delay(420);globalThis.authResetEmailValue=email;write(sessionStorage,KEY.resetRequest,{email,createdAt:now(),expiresAt:now()+TTL.resetLink,consumed:false});document.getElementById('authResetLinkCopy').textContent='如果该邮箱已注册，重置链接将发送至 '+globalThis.maskAuthEmail(email)+'，请在 30 分钟内打开。';showReset('authResetLinkStep');globalThis.startResetCountdown();}catch(_){help.textContent='发送失败，请稍后重试。你填写的邮箱已保留。';}finally{setBusy(button,false,fromLinkStep?'重新发送':'发送重置链接');}
  }
  function openReset(expired=false){const request=read(sessionStorage,KEY.resetRequest,null),account=request&&getUsers()[request.email];if(expired||!request||request.consumed||now()>=request.expiresAt||!account){remove(sessionStorage,KEY.resetSession);showReset('authResetExpiredStep');return;}request.consumed=true;write(sessionStorage,KEY.resetRequest,request);write(sessionStorage,KEY.resetSession,{email:request.email,createdAt:now(),expiresAt:now()+TTL.resetSession});showReset('authResetPasswordStep');focusSoon('authResetPassword');}
  async function completeReset(){
    const reset=read(sessionStorage,KEY.resetSession,null),help=document.getElementById('authResetPasswordSummary'),button=document.getElementById('authResetCompleteButton');help.textContent='';if(!reset||now()>=reset.expiresAt){showReset('authResetExpiredStep');return;}
    if(!globalThis.validatePasswordField('authResetPassword',true,true)){help.textContent=document.getElementById('authResetPasswordHelp').textContent;globalThis.markAuthInvalid('authResetPassword');return;}
    if(!globalThis.validatePasswordField('authResetConfirm',true,true)){help.textContent=document.getElementById('authResetConfirmHelp').textContent;globalThis.markAuthInvalid('authResetConfirm');return;}
    setBusy(button,true,'保存中…');try{await globalThis.delay(420);const users=getUsers(),account=users[reset.email];if(!account){showReset('authResetExpiredStep');return;}account.passwordHash=await globalThis.passwordDigest(document.getElementById('authResetPassword').value);account.passwordUpdatedAt=now();users[reset.email]=account;saveUsers(users);bumpSessionRevision();clearSession('password-reset',false);globalThis.cancelPrototypeRuns?.();clearPending();remove(sessionStorage,KEY.resetSession);document.getElementById('authEmail').value=reset.email;document.getElementById('authPassword').value='';showReset('authResetSuccessStep');globalThis.syncAuthUI();}catch(_){help.textContent='密码保存失败，请重试。已填写内容不会被清空。';}finally{setBusy(button,false,'确认重置密码');}
  }

  function syncUI(){
    const active=sessionState().active,area=document.getElementById('accountArea'),avatar=document.getElementById('accountAvatar'),name=document.getElementById('accountName'),status=document.getElementById('accountStatus'),menu=document.getElementById('accountMenu'),email=getCurrentEmail(),nickname=localStorage.getItem(KEY.nickname)||'';
    area?.classList.toggle('guest-mode',!active);
    if(active){avatar.textContent=(nickname.charAt(0)||email.charAt(0)||'师').toUpperCase();name.textContent=nickname||'个人账号';status.textContent=email;menu.innerHTML='<button class="am-profile-link" type="button" onclick="openPersonalHome()"><b>'+safeText(nickname||'个人账号')+'</b><span>'+safeText(email)+'</span></button><button onclick="openProfile()">我的备课画像</button><div class="sep"></div><button onclick="openHub(\'preferences\')">偏好设置</button><button onclick="showAuthPolicy(\'隐私政策\')">隐私政策</button><button onclick="openHub(\'help\')">帮助与反馈</button><div class="sep"></div><button onclick="openLogoutConfirm()">退出登录</button>';}
    else{avatar.textContent='访';name.textContent='未登录';status.textContent='';menu.classList.remove('show');menu.innerHTML='';}
  }
  function openLogout(){document.getElementById('accountMenu').classList.remove('show');setOverlay('ovLogout',true);focusSoon('authLogoutCancel');}
  function closeLogout(){if(logoutBusy)return;setOverlay('ovLogout',false);}
  async function logout(){
    if(logoutBusy)return;logoutBusy=true;const button=document.getElementById('authLogoutButton'),cancel=document.getElementById('authLogoutCancel'),close=document.getElementById('authLogoutClose');setBusy(button,true,'退出中…');cancel.disabled=true;close.disabled=true;
    try{await globalThis.delay(320);globalThis.cancelPrototypeRuns?.();clearPending();clearSession('logout',false);csrfToken='';syncUI();setOverlay('ovLogout',false);toast('已退出登录，当前设备正在运行的 Agent 任务已停止');}
    finally{logoutBusy=false;setBusy(button,false,'退出登录');cancel.disabled=false;close.disabled=false;}
  }

  function guardWrite(original,metaFactory){return function(...args){const meta=typeof metaFactory==='function'?metaFactory.apply(this,args):metaFactory||{};if(!ensureAuthenticated(()=>original.apply(this,args),meta.title||'登录后继续操作',meta.copy||'登录成功后才会把本次修改写入个人备课空间。',meta))return;return original.apply(this,args);};}
  function wrapWrites(){
    const definitions=[
      ['saveArtifactEdit',(...args)=>({actionType:'save-draft',taskName:'保存当前草稿',nodeId:String(args[0]||currentNodeId()),actionArgs:serializableArgs(args),title:'登录后保存草稿',copy:'你的编辑仍保留在页面中；登录成功后才会保存到个人备课空间。'})],
      ['deliverArtifact',(...args)=>({actionType:'deliver-artifact',confirmed:true,actionArgs:serializableArgs(args),taskName:'确认产物',title:'登录后确认产物',copy:'登录后恢复当前产物，并在再次确认后写入正式版本。'})],
      ['confirmMemory',(...args)=>({actionType:'confirm-memory',actionArgs:serializableArgs(args),taskName:'保存备课偏好',title:'登录后保存备课偏好',copy:'登录成功后才会把这项偏好写入个人备课画像。'})],
      ['confirmInference',(...args)=>({actionType:'confirm-inference',actionArgs:serializableArgs(args),taskName:'确认备课偏好',title:'登录后确认备课偏好',copy:'登录成功后才会把这项偏好写入个人备课画像。'})],
      ['confirmUpgrade',(...args)=>({actionType:'confirm-upgrade',confirmed:true,actionArgs:serializableArgs(args),taskName:'保存活动模式',title:'登录后保存活动模式',copy:'恢复页面后仍会再次确认，避免误写入长期资产。'})],
      ['saveTeacherAutomation',(...args)=>({actionType:'save-automation',actionArgs:serializableArgs(args),taskName:'保存自动化',title:'登录后保存自动化',copy:'自动化配置已保留；登录后才会保存和启用。'})],
      ['addCalendarLesson',(...args)=>({actionType:'add-calendar-lesson',actionArgs:serializableArgs(args),taskName:'新增课程',title:'登录后新增课程',copy:'登录后才会将课程写入教学日历。'})],
      ['archiveFolder',(...args)=>({actionType:'archive-folder',confirmed:true,actionArgs:serializableArgs(args),taskName:'归档项目',title:'登录后归档项目',copy:'恢复页面后需要再次确认，避免误归档。'})],
      ['archiveTask',(...args)=>({actionType:'archive-task',confirmed:true,actionArgs:serializableArgs(args),taskName:'归档任务',title:'登录后归档任务',copy:'恢复页面后需要再次确认，避免误归档。'})],
      ['renameWorkspaceItem',(...args)=>({actionType:'rename-item',actionArgs:serializableArgs(args),taskName:'重命名内容',title:'登录后重命名',copy:'登录后才会保存新的名称。'})],
      ['generateArtifact',(...args)=>({actionType:'generate-artifact',actionArgs:serializableArgs(args),taskName:'生成备课产物',title:'登录后生成产物',copy:'登录成功后才会创建并保存新的备课产物。'})]
    ];
    const seen=new Set();definitions.forEach(([name,meta])=>{if(seen.has(name)||typeof globalThis[name]!=='function'||globalThis[name].__authWrapped)return;seen.add(name);const wrapped=guardWrite(globalThis[name],meta);wrapped.__authWrapped=true;globalThis[name]=wrapped;});
  }

  function handleStorage(event){
    if([KEY.sessionRevision,KEY.session,KEY.sessionMeta].includes(event.key)){const active=sessionState(false).active;syncUI();if(!active&&event.key===KEY.sessionRevision){clearPending();toast('登录状态已在其他页面撤销');}}
    if(event.key===KEY.workspace){const state=currentWorkspace();if(activeGate()&&document.getElementById('authFirstRunState').classList.contains('on'))renderWorkspace(state.status);}
  }
  function keyboard(event){
    if(event.key!=='Escape')return;
    if(document.getElementById('ovAuthResumeConfirm')?.classList.contains('show')){event.stopImmediatePropagation();cancelResume();}
    else if(document.getElementById('ovAuthRetry')?.classList.contains('show')){event.stopImmediatePropagation();closeRetry();}
  }
  function init(){
    issueCsrfToken();syncUI();wrapWrites();window.addEventListener('storage',handleStorage);document.addEventListener('keydown',keyboard,true);
    const workspace=currentWorkspace();if(sessionState(false).active&&workspace.status==='initializing'){const elapsed=now()-(workspace.startedAt||now());if(elapsed>8000){saveWorkspace({...workspace,status:'failed'});renderWorkspace('failed');}else startWorkspaceProvisioning(false);}
    const reg=registrationSession(),view=read(sessionStorage,KEY.view,{});if(reg&&view.state==='authRegisterState'){document.getElementById('authRegisterEmail').value=reg.email;document.getElementById('authInviteCode').value=reg.invite;openGate('authRegisterState');showRegistrationStep(2);}
  }

  globalThis.isAuthActive=()=>sessionState().active;
  globalThis.getAuthEmail=getCurrentEmail;
  globalThis.getAuthUserId=getCurrentEmail;
  globalThis.getPrototypeCsrfToken=getCsrfToken;
  globalThis.createPrototypeSession=createSession;
  globalThis.clearPrototypeSession=clearSession;
  globalThis.getPendingAuthContext=pendingContext;
  globalThis.savePendingAuthContext=savePending;
  globalThis.clearPendingAuthContext=clearPending;
  globalThis.isPendingAuthContextValid=validPending;
  globalThis.restorePendingComposer=restoreContext;
  globalThis.requireAuth=(action,title,copy,meta={})=>ensureAuthenticated(action,title,copy,meta);
  globalThis.resumePendingAuthAction=resumePending;
  globalThis.openAuthGate=openGate;
  globalThis.closeAuthGate=closeGate;
  globalThis.showAuthState=showState;
  globalThis.showResetStep=showReset;
  globalThis.showRegisterStep=showRegistrationStep;
  globalThis.returnToRegisterStep1=backToRegistrationStep1;
  globalThis.loginWithEmail=login;
  globalThis.registerWithEmail=register;
  globalThis.sendResetLink=requestReset;
  globalThis.openResetLink=openReset;
  globalThis.completePasswordReset=completeReset;
  globalThis.completePrototypeAuth=(method,email,isNew,nickname)=>finishAuth(userId(email),isNew,nickname);
  globalThis.beginWorkspaceProvisioning=()=>startWorkspaceProvisioning(false);
  globalThis.finishFirstAuthRun=()=>{if(currentWorkspace().status!=='ready')return;closeGate(true);toast('个人备课空间已准备好');resumePending();};
  globalThis.handleWorkspaceStatusAction=()=>{const status=currentWorkspace().status;if(status==='ready')globalThis.finishFirstAuthRun();else startWorkspaceProvisioning(true);};
  globalThis.syncAuthUI=syncUI;
  globalThis.openLogoutConfirm=openLogout;
  globalThis.closeLogoutConfirm=closeLogout;
  globalThis.confirmLogout=logout;
  globalThis.confirmPendingAuthResume=()=>{if(!resumeConfirmation)return;const item=resumeConfirmation;resumeConfirmation=null;setOverlay('ovAuthResumeConfirm',false);executePending({...item.context,confirmed:false},item.action,false);};
  globalThis.cancelPendingAuthResume=cancelResume;
  globalThis.closePendingAuthRetry=closeRetry;
  globalThis.retryPendingAuthAction=()=>{const context=pendingContext();if(!context)return closeRetry();const action=retryAction||actionFor(context);setOverlay('ovAuthRetry',false);executePending(context,action,false);};
  globalThis.initAuthExperience=init;

  function cancelResume(){resumeConfirmation=null;clearPending();setOverlay('ovAuthResumeConfirm',false);toast('已取消继续执行');}
  function closeRetry(){setOverlay('ovAuthRetry',false);}
})();
