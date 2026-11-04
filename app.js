/**
 * Interactive Sermon Notebook
 * Core Application Logic with Home & Calendar
 */

// Local Storage Mode (Firebase disabled)
let db = null;

let isStateDirty = false;

const CONFIG = {
    SAVE_DELAY: 1000,
    LOOKUP_DELAY: 200,
    BIBLE_API: 'https://bolls.life',
    DEFAULT_VERSION: localStorage.getItem('app_bible_version') || 'NKRV',
    NKRV_URL: 'https://raw.githubusercontent.com/aromkimm/bible/master/src/assets/ko_rev.json',
    KKJV_URL: 'https://raw.githubusercontent.com/scrollmapper/bible_databases/master/sources/ko/KorHKJV/KorHKJV.json'
};

let NKRV_DATA = null;
let KKJV_DATA = null;

// State & User Storage Helpers
function getUserStorageKeys() {
    return {
        notes: 'sermon_notes',
        deletedNotes: 'sermon_deleted_notes',
        worshipTypes: 'sermon_worship_types',
        expandedWorshipTypes: 'sermon_expanded_worship_types'
    };
}

function loadUserNotesFromStorage() {
    const keys = getUserStorageKeys();
    
    // Auto-migration: Consolidate any legacy user-scoped keys (e.g. sermon_notes_user_*) into master 'sermon_notes'
    try {
        let masterNotes = {};
        const baseRaw = localStorage.getItem(keys.notes);
        if (baseRaw) {
            try { masterNotes = JSON.parse(baseRaw) || {}; } catch (e) {}
        }
        
        let hasMerged = false;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('sermon_notes_') && k !== keys.notes) {
                try {
                    const legacy = JSON.parse(localStorage.getItem(k) || '{}');
                    Object.keys(legacy).forEach(id => {
                        if (!masterNotes[id]) {
                            masterNotes[id] = legacy[id];
                            hasMerged = true;
                        }
                    });
                } catch(e) {}
            }
        }
        if (hasMerged) {
            localStorage.setItem(keys.notes, JSON.stringify(masterNotes));
        }
        state.notes = masterNotes;
    } catch (e) {
        try {
            const raw = localStorage.getItem(keys.notes);
            state.notes = raw ? JSON.parse(raw) : {};
        } catch(err) {
            state.notes = {};
        }
    }

    try {
        const raw = localStorage.getItem(keys.deletedNotes);
        state.deletedNotes = raw ? JSON.parse(raw) : [];
    } catch (e) {
        state.deletedNotes = [];
    }

    try {
        const rawWT = localStorage.getItem(keys.worshipTypes);
        if (rawWT) {
            state.worshipTypes = JSON.parse(rawWT);
        } else {
            state.worshipTypes = ['주일예배', '금요예배'];
        }
        
        if (Array.isArray(state.worshipTypes) && 
            state.worshipTypes.length === 4 && 
            state.worshipTypes.includes('주일예배') && 
            state.worshipTypes.includes('금요예배') && 
            state.worshipTypes.includes('수요예배') && 
            state.worshipTypes.includes('새벽예배')) {
            state.worshipTypes = ['주일예배', '금요예배'];
            localStorage.setItem(keys.worshipTypes, JSON.stringify(state.worshipTypes));
        }
    } catch (e) {
        state.worshipTypes = ['주일예배', '금요예배'];
    }

    try {
        const rawExpWT = localStorage.getItem(keys.expandedWorshipTypes);
        state.expandedWorshipTypes = rawExpWT ? JSON.parse(rawExpWT) : [];
    } catch (e) {
        state.expandedWorshipTypes = [];
    }
}

let drawingUndoStack = [];
let savedSelectionRange = null;
document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        let node = range.commonAncestorContainer;
        if (node.nodeType === Node.TEXT_NODE) {
            node = node.parentNode;
        }
        if (node && node.closest && node.closest('.sermon-editor')) {
            savedSelectionRange = range;
            window._lastActiveEditor = node.closest('.sermon-editor');
            
            // Caret auto-scroll to keep it visible (only when it is a collapsed cursor)
            if (sel.isCollapsed) {
                deferCaretCheck();
            }
        }
    }
});
// IndexedDB for Recordings
const RecordDB = {
    dbName: 'SermonRecordingsDB',
    dbVersion: 1,
    storeName: 'recordings',
    db: null,
    
    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = (e) => reject('IndexedDB error: ' + e.target.error);
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
        });
    },
    
    save(id, title, dateStr, blob, noteId) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject('DB not initialized');
            try {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.put({ id, title, dateStr, blob, noteId: noteId || null, timestamp: Date.now() });
                request.onsuccess = () => resolve();
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    },
    
    getAll() {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject('DB not initialized');
            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result.sort((a,b) => b.timestamp - a.timestamp));
            request.onerror = (e) => reject(e.target.error);
        });
    },
    
    delete(id) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject('DB not initialized');
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
};

RecordDB.init().catch(console.error);

let state = {
    currentNoteId: null,
    currentPageIndex: 0,
    notes: {},
    deletedNotes: [],
    worshipTypes: ['주일예배', '금요예배'],
    expandedWorshipTypes: [],
    detectedVerses: new Set(),
    isSaving: false,
    allVersesHidden: false,
    currentDate: new Date(), 
    view: 'home',
    versePositions: [], 
    theme: localStorage.getItem('app_theme') || 'light',
    fontSize: 16,
    bibleFontSize: parseInt(localStorage.getItem('app_bible_font_size')) || 15,
    autoInsert: localStorage.getItem('app_auto_insert') !== null ? localStorage.getItem('app_auto_insert') === 'true' : /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
    bibleVersion: localStorage.getItem('app_bible_version') || 'NKRV',
    user: null,
    // 사용자 신원 (교구명/셀명/성도명)
    identity: JSON.parse(localStorage.getItem('app_user_identity') || 'null'),
    // 홈 화면: 펼쳐진 월 목록 (가장 최근 달만 기본 펼쳐집)
    expandedMonths: null,
    // 홈 화면 뷰 모드: 'worship' (예배별) or 'all' (모두 보기)
    homeViewMode: localStorage.getItem('home_view_mode') || 'worship',
    // 현재 선택된 예배 타입 필터 (홈)
    homeFilterType: localStorage.getItem('home_filter_type') || 'all'
};

// Initial load of user notes from scoped storage
loadUserNotesFromStorage();

// DOM Elements
let elements = {};

// Drawing / Pen Canvas State
let drawingCtx = null;
let isDrawing = false;
let lastX = 0;
let lastY = 0;

// Weather State
let isWeatherFetched = false;

function updateElementReferences() {
    elements = {
        // Views
        homeView: document.getElementById('home-view'),
        editorView: document.getElementById('editor-bible-view'),
        calendarView: document.getElementById('calendar-view'),
        adminView: document.getElementById('admin-view'),
        
        // Lists
        homeNoteList: document.getElementById('home-note-list'),
        worshipTypeList: document.getElementById('worship-type-list'),
        calendarDays: document.getElementById('calendar-days'),
        calendarMonthYear: document.getElementById('calendar-month-year'),
        
        // Editor
        editor: document.querySelector('.sermon-editor'),
        titleInput: document.getElementById('note-title'),
        noteWorshipType: document.getElementById('note-worship-type'),
        noteDate: document.getElementById('note-date'),
        verseGallery: document.getElementById('verse-gallery'),
        verseCount: document.getElementById('verse-count'),
        versionButtons: document.querySelectorAll('.v-btn'),
        toast: document.getElementById('toast'),
        deleteBtn: document.getElementById('delete-note-btn'),
        shareBtn: document.getElementById('share-note-btn'),

        // Calendar Pane
        calendarNotesPane: document.getElementById('calendar-notes-pane'),
        calendarPaneDate: document.getElementById('calendar-pane-date'),
        calendarPaneList: document.getElementById('calendar-pane-list')
    };
}
async function init() {
    // 1. 카카오 리다이렉트 확인 (네이버처럼 해시 또는 카카오 세션 복구)
    // 네이버는 initNaverLogin() 에서 해시를 처리하므로 여기서는 카카오 SDK 토큰만 확인
    
    // Removed forced reset of custom projects list to preserve user-added projects

    // Migration: Ensure existing notes have worshipType and isoDate
    if (state.notes) {
        let migrated = false;
        Object.keys(state.notes).forEach(id => {
            if (!state.notes[id].worshipType) {
                state.notes[id].worshipType = '주일예배';
                migrated = true;
            }
            if (!state.notes[id].isoDate) {
                try {
                    const cleanDate = (state.notes[id].date || '').replace(/\s/g, '').replace(/\.$/, '');
                    const parts = cleanDate.split('.');
                    if (parts.length === 3) {
                        state.notes[id].isoDate = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
                    } else {
                        state.notes[id].isoDate = new Date(state.notes[id].timestamp || Date.now()).toISOString().split('T')[0];
                    }
                } catch(e) {
                    state.notes[id].isoDate = new Date(state.notes[id].timestamp || Date.now()).toISOString().split('T')[0];
                }
                migrated = true;
            }
        });
        if (migrated) {
            saveToStorage();
        }
    }

    applyTheme();
    updateElementReferences();
    requestStoragePersistence();
    startAppWithIdentity();
}

function requestStoragePersistence() {
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(granted => {
            if (granted) {
                console.log("Storage persistence granted: Local data will not be cleared by browser.");
            }
        }).catch(e => console.warn("Storage persist request error:", e));
    }
}

/* ==========================================================================
   User Identity Functions
   ========================================================================== */
function showIdentityModal() {
    const modal = document.getElementById('user-identity-modal');
    if (!modal) return;
    modal.classList.add('active');

    // Attach event listeners for social buttons
    const btnGoogle = document.getElementById('btn-login-google');
    const btnKakao = document.getElementById('btn-login-kakao');
    const btnNaver = document.getElementById('btn-login-naver');
    if (btnGoogle) btnGoogle.onclick = loginGoogle;
    if (btnKakao) btnKakao.onclick = loginKakao;
    if (btnNaver) btnNaver.onclick = loginNaver;
    
    const btnGuest = document.getElementById('btn-guest-login');
    if (btnGuest) {
        btnGuest.onclick = () => {
            state.identity = {
                name: '비회원',
                gyogu: '',
                sel: '',
                provider: 'guest',
                isGuest: true
            };
            finishLogin();
        };
    }
}

async function loginGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
        const result = await firebase.auth().signInWithPopup(provider);
        if (result && result.user) {
            handleAuthResult(result.user, 'google');
        }
    } catch (error) {
        console.error("Google Login Error:", error);
        if (error.code !== 'auth/popup-closed-by-user') {
            alert("구글 로그인 오류 (" + error.code + "):\n" + error.message + "\n\n(안드로이드 앱 환경에서는 구글 로그인이 차단될 수 있습니다. 이 경우 카카오/네이버 로그인을 이용해 주세요.)");
        }
    }
}

function applyBibleFontSize() {
    const displayEl = document.getElementById('bible-font-display');
    if (displayEl) {
        displayEl.textContent = state.bibleFontSize;
    }
    const gallery = document.getElementById('verse-gallery');
    if (gallery) {
        gallery.style.setProperty('--bible-font-size', state.bibleFontSize + 'px');
        // Also directly set font-size on all verse-text elements for guaranteed mobile support
        gallery.querySelectorAll('.verse-text').forEach(el => {
            el.style.fontSize = state.bibleFontSize + 'px';
        });
    }
}

function loginKakao() {
    try {
        if (!window.Kakao) {
            alert("카카오 SDK가 아직 준비되지 않았습니다. 인터넷 연결을 확인해주세요.");
            return;
        }
        if (!Kakao.isInitialized()) {
            Kakao.init('8a87947faed444d207ea61de155881ca'); 
        }
        
        Kakao.Auth.login({
            throughTalk: false, // 안드로이드 웹뷰(앱) 환경에서 intent:// 앱 전환 오류 방지용 (웹 로그인 폼 강제)
            success: function(authObj) {
                const btn = document.getElementById("btn-login-kakao");
                if (btn) btn.innerHTML = "카카오 로그인 처리 중... <i class='fas fa-spinner fa-spin'></i>";
                
                Kakao.API.request({
                    url: '/v2/user/me',
                    success: function(res) {
                        state.identity = {
                            uid: 'kakao:' + res.id,
                            name: res.kakao_account?.profile?.nickname || '카카오 사용자',
                            email: res.kakao_account?.email || '',
                            photoURL: res.kakao_account?.profile?.thumbnail_image_url || '',
                            provider: 'kakao',
                            isGuest: false
                        };
                        finishLogin();
                        if (btn) btn.innerHTML = "<i class='fas fa-comment'></i>카카오로 로그인";
                    },
                    fail: function(error) {
                        console.error("Kakao API Error:", error);
                        alert("카카오 프로필 정보를 가져오는데 실패했습니다: " + JSON.stringify(error));
                        if (btn) btn.innerHTML = "<i class='fas fa-comment'></i>카카오로 로그인";
                    }
                });
            },
            fail: function(err) {
                console.error("Kakao Login Error:", err);
                alert("카카오 로그인 실패 (인증 거절 또는 설정 오류): " + JSON.stringify(err));
            }
        });
    } catch(e) {
        alert("카카오 로그인 실행 중 오류: " + e.message);
    }
}

let naverLoginInstance = null;

function initNaverLogin() {
    if (!window.naver) return;
    naverLoginInstance = new naver.LoginWithNaverId({
        clientId: "fih_pgOe0LfDLxMaAZBK", 
        callbackUrl: "https://sermon-note-35104.web.app/index.html",
        isPopup: false,
        loginButton: {color: "green", type: 3, height: 60}, // 이 설정이 없으면 버튼이 생성되지 않음
        callbackHandle: true
    });
    naverLoginInstance.init();
    
    const checkNaverCallback = function () {
        if (window.location.hash.includes('access_token')) {
            const btn = document.getElementById("btn-login-naver");
            if (btn) btn.innerHTML = "네이버 로그인 처리 중... <i class='fas fa-spinner fa-spin'></i>";
            
            const fallbackTimer = setTimeout(() => {
                alert("네이버 서버 응답이 지연되거나 차단되었습니다. 설정을 확인해주세요.");
                if (btn) btn.innerHTML = '<strong style="display:inline-block; width:24px; font-family:arial; font-size:18px; font-weight:bold; margin-right:8px;">N</strong>네이버로 로그인';
            }, 6000);

            naverLoginInstance.getLoginStatus(function (status) {
                clearTimeout(fallbackTimer);
                if (status) {
                    try {
                        const user = naverLoginInstance.user;
                        if (!user) throw new Error("사용자 객체 없음");
                        
                        const email = user.getEmail() || '';
                        const name = user.getNickName() || user.getName() || '네이버 사용자';
                        const rawId = (user.getId && typeof user.getId === 'function' ? user.getId() : null) || user.id || email || name || 'user';
                        const cleanId = String(rawId).replace(/[/\\#?]/g, '_');
                        
                        state.identity = {
                            uid: 'naver:' + cleanId,
                            name: name,
                            email: email,
                            photoURL: user.getProfileImage() || '',
                            provider: 'naver',
                            isGuest: false
                        };
                        finishLogin();
                        if (window.location.hash.includes('access_token')) {
                            window.history.replaceState(null, null, '/');
                        }
                    } catch(e) {
                        console.error("Naver parsing error:", e);
                        alert("네이버 프로필 정보를 읽는 중 오류가 발생했습니다.");
                        if (btn) btn.innerHTML = '<strong style="display:inline-block; width:24px; font-family:arial; font-size:18px; font-weight:bold; margin-right:8px;">N</strong>네이버로 로그인';
                    }
                } else {
                    alert("네이버 로그인 정보를 받아오지 못했습니다. (네이버 개발자 센터의 '서비스 URL' 설정을 확인해주세요.)");
                    if (btn) btn.innerHTML = '<strong style="display:inline-block; width:24px; font-family:arial; font-size:18px; font-weight:bold; margin-right:8px;">N</strong>네이버로 로그인';
                }
            });
        }
    };

    if (document.readyState === 'complete') {
        checkNaverCallback();
    } else {
        window.addEventListener('load', checkNaverCallback);
    }
}

function loginNaver() {
    try {
        if (!window.naver || !naverLoginInstance) {
            alert("네이버 SDK가 아직 준비되지 않았습니다. 새로고침 후 다시 시도해주세요.");
            return;
        }
        const naverBtn = document.getElementById("naverIdLogin").querySelector("a");
        if (naverBtn) {
            naverBtn.click();
        } else {
            alert("네이버 로그인 버튼이 아직 화면에 생성되지 않았습니다. (Callback URL 설정 누락일 수 있습니다.)");
        }
    } catch(e) {
        alert("네이버 로그인 실행 중 오류: " + e.message);
    }
}

function handleAuthResult(user, provider) {
    state.identity = {
        uid: user.uid,
        name: user.displayName || '소셜 사용자',
        email: user.email,
        photoURL: user.photoURL,
        provider: provider
    };
    finishLogin();
}

function finishLogin() {
    localStorage.setItem('app_user_identity', JSON.stringify(state.identity));
    const modal = document.getElementById('user-identity-modal');
    if (modal) modal.classList.remove('active');
    
    // 새로 고침하여 데이터를 깔끔하게 다시 불러옵니다 (이벤트 중복 등록 방지)
    window.location.reload();
}

function getIdentityDocId() {
    if (!state.identity) return null;
    if (state.identity.uid) return state.identity.uid;
    // Legacy support
    const { gyogu, sel, name } = state.identity;
    if (gyogu && sel && name) {
        return `user_${gyogu}_${sel}_${name}`.replace(/[/\\#?]/g, '_');
    }
    return null;
}

function updateIdentityBadge() {
    const badge = document.getElementById('user-identity-badge');
    if (!badge || !state.identity) return;
    
    const span = badge.querySelector('span');
    if (span) {
        const displayName = state.identity.name ? state.identity.name.substring(0, 2) : '';
        if (state.identity.photoURL) {
            span.innerHTML = `<img src="${state.identity.photoURL}" style="width:20px;height:20px;border-radius:50%;margin-right:5px;vertical-align:middle;display:inline-block;" /> ${displayName}`;
        } else {
            span.textContent = `${displayName}`;
        }
    }
    badge.style.display = 'flex';
}

function startAppWithIdentity() {
    setupEventListeners();
    applyAutoInsertUI();
    updateIdentityBadge();
    fetchWeatherGreeting();
    
    // Load Bible Data
    loadNkrvData();
    loadKkjvData();
    
    applyBibleFontSize();

    if (elements.versionButtons) {
        elements.versionButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.version === state.bibleVersion);
            btn.onclick = (e) => {
                const newVersion = e.currentTarget.dataset.version;
                if (state.bibleVersion === newVersion) return;
                
                state.bibleVersion = newVersion;
                localStorage.setItem('app_bible_version', state.bibleVersion);
                
                // Update UI buttons
                elements.versionButtons.forEach(b => b.classList.toggle('active', b.dataset.version === state.bibleVersion));
                
                // Refresh verses
                const textContent = document.querySelector('.sermon-editor').innerText;
                state.detectedVerses.clear();
                if (elements.verseGallery) elements.verseGallery.innerHTML = '';
                detectBibleReferences(textContent);
                showToast(`${state.bibleVersion === 'NKRV' ? '개역개정' : '흠정역'} 버전으로 변경됨`);
            };
        });
    }

    renderHomeNotes();
    renderCalendar();
}

async function loadKkjvData() {
    try {
        const response = await fetch(CONFIG.KKJV_URL);
        KKJV_DATA = await response.json();
        console.log("KKJV Data Loaded");
        if (state.view === 'editor' && state.bibleVersion === 'KKJV') {
            detectBibleReferences(document.querySelector('.sermon-editor').innerText);
        }
    } catch (e) {
        console.error("Failed to load KKJV data", e);
    }
}

async function loadNkrvData() {
    try {
        const response = await fetch(CONFIG.NKRV_URL);
        NKRV_DATA = await response.json();
        console.log("NKRV Data Loaded");
        // If we are already in editor, re-detect to show verses
        if (state.view === 'editor') {
            detectBibleReferences(document.querySelector('.sermon-editor').innerText);
        }
    } catch (e) {
        console.error("Failed to load NKRV data", e);
    }
}

// ✅ FIX 4: 실시간 Firestore 리스너 (기기간 동기화 개선)
let _firestoreUnsubscribe = null;

function applyCloudData(data) {
    if (!data) return;
    let cloudNotes = data.notes || {};
    let deletedNotes = data.deletedNotes || [];

    // Sync Theme if exists in cloud
    if (data.theme && data.theme !== state.theme) {
        state.theme = data.theme;
        localStorage.setItem('app_theme', state.theme);
        applyTheme();
    }
    if (data.fontSize && data.fontSize !== state.fontSize) {
        state.fontSize = data.fontSize;
        localStorage.setItem('app_font_size', state.fontSize);
        applyFontSize();
    }
    if (data.fontFamily && data.fontFamily !== state.fontFamily) {
        state.fontFamily = data.fontFamily;
        localStorage.setItem('app_font_family', state.fontFamily);
        applyFontFamily();
    }
    if (data.worshipTypes && Array.isArray(data.worshipTypes)) {
        state.worshipTypes = Array.from(new Set([...state.worshipTypes, ...data.worshipTypes]));
        const keys = getUserStorageKeys();
        localStorage.setItem(keys.worshipTypes, JSON.stringify(state.worshipTypes));
    }

    // Migrate cloud notes
    Object.keys(cloudNotes).forEach(id => {
        if (!cloudNotes[id].worshipType) cloudNotes[id].worshipType = '주일예배';
        if (!cloudNotes[id].isoDate) {
            try {
                const cleanDate = (cloudNotes[id].date || '').replace(/\s/g, '').replace(/\.$/, '');
                const parts = cleanDate.split('.');
                if (parts.length === 3) {
                    cloudNotes[id].isoDate = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
                } else {
                    cloudNotes[id].isoDate = new Date(cloudNotes[id].timestamp || Date.now()).toISOString().split('T')[0];
                }
            } catch(e) {
                cloudNotes[id].isoDate = new Date(cloudNotes[id].timestamp || Date.now()).toISOString().split('T')[0];
            }
        }
    });

    // Merge deletedNotes with user-scoped key
    const mergedDeleted = Array.from(new Set([...state.deletedNotes, ...deletedNotes]));
    state.deletedNotes = mergedDeleted;
    const keys = getUserStorageKeys();
    localStorage.setItem(keys.deletedNotes, JSON.stringify(state.deletedNotes));

    // Bi-directional merge with local notes
    let hasLocalChangesToUpload = false;
    const mergedNotes = { ...state.notes };

    // Remove deleted notes
    state.deletedNotes.forEach(id => {
        if (mergedNotes[id]) delete mergedNotes[id];
    });

    // Process notes from cloud
    Object.keys(cloudNotes).forEach(id => {
        if (state.deletedNotes.includes(id)) return;
        const cloudNote = cloudNotes[id];
        const localNote = mergedNotes[id];

        if (!localNote) {
            mergedNotes[id] = cloudNote;
        } else {
            const cloudTs = cloudNote.timestamp || 0;
            const localTs = localNote.timestamp || 0;
            if (cloudTs > localTs) {
                mergedNotes[id] = cloudNote;
            } else if (localTs > cloudTs) {
                hasLocalChangesToUpload = true;
            }
        }
    });

    // Check if local has notes that cloud does NOT have
    Object.keys(mergedNotes).forEach(id => {
        if (!cloudNotes[id] && !state.deletedNotes.includes(id)) {
            hasLocalChangesToUpload = true;
        }
    });

    state.notes = mergedNotes;
    saveToStorage();

    if (hasLocalChangesToUpload) {
        isStateDirty = true;
        syncToFirestore();
    } else {
        isStateDirty = false;
    }

    renderHomeNotes();
    renderCalendar();

    if (state.view === 'editor' && state.currentNoteId && mergedNotes[state.currentNoteId]) {
        const vc = document.querySelector('.view-container');
        const isEditing = vc && vc.classList.contains('is-typing');
        if (!isEditing) {
            const currentNote = mergedNotes[state.currentNoteId];
            if (!currentNote.pages || !Array.isArray(currentNote.pages)) {
                currentNote.pages = [ { content: currentNote.content || '', drawingData: currentNote.drawingData || null } ];
            }
            if (state.currentPageIndex >= currentNote.pages.length) {
                state.currentPageIndex = currentNote.pages.length - 1;
            }
            const titleInput = document.getElementById('note-title');
            if (titleInput && titleInput.value !== (currentNote.title || '')) {
                titleInput.value = currentNote.title || '';
            }
            renderAllPages(currentNote);
            updatePageNavigator();
        }
    }
}

async function syncFromFirestore() { return; }
async function syncToFirestore() { return; }

// Optimization: Debounce helper
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ✅ 비용 최적화: 실제 데이터가 변경되었을 때만 isStateDirty를 true로 설정하고,
// 30초 후(또는 앱 종료 시) 한 번에 Firestore에 저장합니다.
const debouncedSyncToFirestore = debounce(() => {
    syncToFirestore();
}, 10000); // 10초 (3초에서 10초로 조절하여 Firestore 쓰기 비용 절감과 빠른 동기화의 균형 유지)

// 페이지 이탈(탭 닫기, 새로고침) 직전에는 즉시 Firestore 저장
window.addEventListener('beforeunload', () => {
    syncToFirestore();
});

// PWA: visibilitychange (앱을 백그라운드로 보낼 때도 즉시 저장)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        syncToFirestore();
    }
});

let isComposing = false;
let lookupTimeout = null;
let caretTimeout = null;
let typingHideTimeout = null;

const triggerTypingMode = () => {
    document.querySelector('.view-container')?.classList.add('is-typing');
    document.body.classList.add('typing-mode');
    clearTimeout(typingHideTimeout);
    typingHideTimeout = setTimeout(() => {
        document.querySelector('.view-container')?.classList.remove('is-typing');
        document.body.classList.remove('typing-mode');
    }, 2000);
};

function focusEndOfEditor(editor) {
    if (!editor) return;
    editor.focus();
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function ensureCaretIsVisible() {
    const editorArea = document.querySelector('.editor-area');
    const activeEditor = document.activeElement;
    if (!editorArea || !activeEditor || !activeEditor.classList.contains('sermon-editor')) return;
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    try {
        const range = selection.getRangeAt(0);
        let rect = range.getBoundingClientRect();

        // 빈 줄(엔터 후 생긴 <div><br> 등)은 rect가 {height:0, width:0}으로 옴 → 정확한 위치 계산
        if (!rect || (rect.height === 0 && rect.width === 0)) {
            // 1차: getClientRects()로 실제 커서 위치 시도
            const rects = range.getClientRects();
            if (rects && rects.length > 0) {
                rect = rects[rects.length - 1];
            }
        }

        if (!rect || (rect.height === 0 && rect.width === 0)) {
            let node = range.startContainer;
            let offset = range.startOffset;

            if (node.nodeType === Node.TEXT_NODE) {
                node = node.parentNode;
            }

            // 2차: 현재 노드의 getBoundingClientRect 시도
            if (node && node.nodeType === Node.ELEMENT_NODE && node !== activeEditor) {
                rect = node.getBoundingClientRect();
            }

            // 3차: activeEditor 자식 노드 기반 fallback
            if ((!rect || rect.height === 0) && node === activeEditor) {
                const childIndex = Math.max(0, Math.min(offset, node.childNodes.length - 1));
                const child = node.childNodes[childIndex];
                if (child && child.nodeType === Node.ELEMENT_NODE) {
                    rect = child.getBoundingClientRect();
                } else if (child && child.nodeType === Node.TEXT_NODE) {
                    const tempRange = document.createRange();
                    tempRange.selectNodeContents(child);
                    rect = tempRange.getBoundingClientRect();
                }
            }
        }

        // rect가 유효하지 않거나 뷰포트 밖의 0 위치이면 무시
        if (!rect || (rect.height === 0 && rect.width === 0)) return;
        // top이 0이고 bottom도 0이면 DOM에 렌더되지 않은 빈 rect → 무시
        if (rect.top === 0 && rect.bottom === 0) return;

        const vv = window.visualViewport;
        const vvHeight = vv ? vv.height : window.innerHeight;
        const vvTop = vv ? vv.offsetTop : 0;
        
        const PADDING = 80;
        const visibleBottom = vvTop + vvHeight - PADDING;

        const containerRect = editorArea.getBoundingClientRect();
        const containerTop = Math.max(containerRect.top, vvTop) + 40;

        if (rect.bottom > visibleBottom) {
            editorArea.scrollTop += (rect.bottom - visibleBottom);
        } else if (rect.top < containerTop) {
            editorArea.scrollTop -= (containerTop - rect.top);
        }
    } catch (err) {}
}

function deferCaretCheck() {
    clearTimeout(caretTimeout);
    caretTimeout = setTimeout(ensureCaretIsVisible, 50);
}

function getGlobalCursorPos() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0);
    
    const activeEditor = document.activeElement;
    if (!activeEditor || !activeEditor.classList.contains('sermon-editor')) return 0;
    
    const wrappers = document.querySelectorAll('.a4-page-wrapper');
    let globalPos = 0;
    
    for (let i = 0; i < wrappers.length; i++) {
        const editor = wrappers[i].querySelector('.sermon-editor');
        if (editor === activeEditor) {
            const preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(editor);
            preCaretRange.setEnd(range.endContainer, range.endOffset);
            globalPos += preCaretRange.toString().length;
            break;
        } else {
            globalPos += editor.innerText.length;
        }
    }
    return globalPos;
}

// ✅ FIX #3: detectBibleReferences를 debounce로 처리하여 타이핑 성능 최적화
const debouncedDetectBibleRefs = debounce((text) => {
    detectBibleReferences(text);
}, 500);

const debouncedSync = debounce(syncBibleScroll, 100);

// ✅ FIX #1: 툴바 패널 열기 시 에디터 스크롤 위치 보존 유틸리티
function preserveEditorScroll(fn) {
    const editorArea = document.querySelector('.editor-area');
    const scrollTop = editorArea ? editorArea.scrollTop : 0;
    fn();
    if (editorArea) {
        // 다음 프레임에서 스크롤 복원
        requestAnimationFrame(() => {
            editorArea.scrollTop = scrollTop;
        });
    }
}

function setupEventListeners() {
    // --- History & Back Button Handling ---
    if (!history.state || history.state.view !== 'home') {
        history.replaceState({ view: 'exit' }, '', '#exit');
        history.pushState({ view: 'home' }, '', '#home');
    }

    window.addEventListener('popstate', (e) => {
        // 1. 설교/기도노트 에디터 상태에서 뒤로가기 시 설교노트 목록으로 복귀
        if (state.view === 'editor') {
            returnToSermonListFromEditor();
            return;
        }

        // 2. 성경, 찾기, 설교노트 화면에서 뒤로가기 시 메인으로 복귀
        if (currentTab === 'bible' || currentTab === 'search' || currentTab === 'sermon') {
            showMainHome(false);
            return;
        }

        // 3. 메인 화면(말씀카드 홈)에서 백버튼 누르면 '나가시겠습니까' 확인창 표시
        if (confirm('설교노트에서 나가시겠습니까?')) {
            history.back();
        } else {
            history.pushState({ view: 'home' }, '', '#home');
        }
    });
    // --------------------------------------

    // Navigation
    document.getElementById('main-new-note-btn').onclick = () => openNoteMetaModal('create');
    
    const closeNewNoteBtn = document.getElementById('close-new-note-modal');
    if (closeNewNoteBtn) closeNewNoteBtn.onclick = closeNewNoteModal;
    
    const saveNewNoteBtn = document.getElementById('save-new-note');
    if (saveNewNoteBtn) saveNewNoteBtn.onclick = saveNoteMetaFromModal;

    const editMetaBtn = document.getElementById('edit-note-meta-btn');
    if (editMetaBtn) editMetaBtn.onclick = () => openNoteMetaModal('edit');

    // Add worship type button in drawer
    const addWorshipBtn = document.getElementById('add-worship-type-btn');
    if (addWorshipBtn) addWorshipBtn.onclick = openWorshipModal;
    


    // 에디터 백버튼 (설교/기도노트에서 누르면 설교노트 창/목록으로 이동)
    const backBtn = document.getElementById('back-to-home');
    if (backBtn) {
        backBtn.onclick = (e) => {
            e.preventDefault();
            returnToSermonListFromEditor();
        };
    }

    // 통합 되돌리기 버튼 (글자쓰기 & 노트펜 모드 공통)
    const unifiedUndoBtn = document.getElementById('btn-unified-undo');
    if (unifiedUndoBtn) {
        unifiedUndoBtn.onmousedown = (e) => {
            e.preventDefault(); // 에디터 포커스 유지
            handleUnifiedUndo(e);
        };
        unifiedUndoBtn.onclick = (e) => {
            e.preventDefault();
            handleUnifiedUndo(e);
        };
    }
    document.getElementById('calendar-toggle-btn').onclick = () => {
        closeCalendarNotesPane();
        elements.calendarView.classList.add('active');
        renderCalendar();
    };

    // Worship Types
    document.getElementById('close-worship-modal').onclick = closeWorshipModal;
    document.getElementById('save-worship-type').onclick = saveNewWorshipType;

    // Calendar Pane
    document.getElementById('back-to-calendar').onclick = closeCalendarNotesPane;
    document.getElementById('close-calendar-pane').onclick = () => {
        closeCalendarNotesPane();
        elements.calendarView.classList.remove('active');
    };

    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
        themeBtn.onclick = toggleTheme;
        setupAdminLongPress(themeBtn);
    }

    const editorThemeBtn = document.getElementById('editor-theme-toggle');
    if (editorThemeBtn) {
        editorThemeBtn.onclick = toggleTheme;
        setupAdminLongPress(editorThemeBtn);
    }

    const fontSizeSelect = document.getElementById('font-size');
    if (fontSizeSelect) {
        fontSizeSelect.addEventListener('change', (e) => {
            changeFontSizeTo(parseInt(e.target.value));
        });
    }

    const btnBibleFontDecrease = document.getElementById('btn-bible-font-decrease');
    const btnBibleFontIncrease = document.getElementById('btn-bible-font-increase');
    
    const handleBibleFontDecrease = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (state.bibleFontSize > 10) {
            state.bibleFontSize--;
            localStorage.setItem('app_bible_font_size', state.bibleFontSize);
            applyBibleFontSize();
        }
    };
    
    const handleBibleFontIncrease = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (state.bibleFontSize < 40) {
            state.bibleFontSize++;
            localStorage.setItem('app_bible_font_size', state.bibleFontSize);
            applyBibleFontSize();
        }
    };

    if (btnBibleFontDecrease) {
        btnBibleFontDecrease.addEventListener('pointerdown', handleBibleFontDecrease, {passive: false});
    }
    if (btnBibleFontIncrease) {
        btnBibleFontIncrease.addEventListener('pointerdown', handleBibleFontIncrease, {passive: false});
    }

    const lineSpacingSelect = document.getElementById('note-style-lined');
    if (lineSpacingSelect) {
        lineSpacingSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val !== 'none') {
                localStorage.setItem('noteLineHeight', val);
                applyFontSize();
            }
        });
    }

    const autoInsertToggle = document.getElementById('auto-insert-toggle');
    if (autoInsertToggle) {
        autoInsertToggle.onclick = (e) => {
            const btn = e.target.closest('.control-btn');
            if (!btn) return;
            const newMode = btn.dataset.mode === 'auto';
            if (state.autoInsert !== newMode) toggleAutoInsert();
        };
    }

    document.getElementById('close-calendar').onclick = () => elements.calendarView.classList.remove('active');
    
    // Calendar Month Nav
    document.getElementById('prev-month').onclick = () => {
        state.currentDate.setMonth(state.currentDate.getMonth() - 1);
        renderCalendar();
    };
    document.getElementById('next-month').onclick = () => {
        state.currentDate.setMonth(state.currentDate.getMonth() + 1);
        renderCalendar();
    };

    // Identity badge click → 신원 변경
    const identityBadge = document.getElementById('user-identity-badge');
    if (identityBadge) {
        identityBadge.onclick = () => {
            if (confirm('사용자 정보를 변경하시겠습니까?\n변경 후 모바일에는 새 계정으로 연동됩니다.')) {
                const keys = getUserStorageKeys();
                localStorage.removeItem(keys.notes);
                localStorage.removeItem(keys.deletedNotes);
                localStorage.removeItem(keys.worshipTypes);
                localStorage.removeItem(keys.expandedWorshipTypes);
                localStorage.removeItem('app_user_identity');
                
                // 파이어베이스 구글 로그아웃 처리
                if (window.firebase && firebase.auth) {
                    firebase.auth().signOut().catch(e => console.error(e));
                }
                
                // 카카오 로그아웃 처리 (토큰 자동 복구 방지)
                if (window.Kakao && Kakao.Auth && Kakao.Auth.getAccessToken()) {
                    Kakao.Auth.logout(function() {
                        location.reload();
                    });
                } else {
                    location.reload();
                }
            }
        };
    }

    if (elements.shareBtn) {
        elements.shareBtn.onclick = shareCurrentNote;
    }
    
    // selectionchange fires reliably on both enter key and virtual keyboard on iOS/Android
    document.addEventListener('selectionchange', () => {
        if (document.activeElement && document.activeElement.classList.contains('sermon-editor')) {
            // ✅ FIX 3: 타이핑 중에는 성경 구절 싱크 생략 (입력 지연 개선)
            const vc = document.querySelector('.view-container');
            const isTyping = vc && vc.classList.contains('is-typing');
            deferCaretCheck();
            if (!isTyping) debouncedSync();
        }
    });
    // Also attach to visualViewport resize (keyboard open/close) to re-check immediately
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            if (document.activeElement && document.activeElement.classList.contains('sermon-editor')) {
                deferCaretCheck();
                // Run delayed checks to ensure caret visibility after keyboard animation completes
                setTimeout(ensureCaretIsVisible, 150);
                setTimeout(ensureCaretIsVisible, 300);
                setTimeout(ensureCaretIsVisible, 500);
            }
        });
    }

    // Rich Toolbar Events
    setupToolbarEvents();

    if (elements.titleInput) {
        elements.titleInput.addEventListener('input', autoSave);
    }

    // Metadata Changes
    if (elements.noteWorshipType) {
        elements.noteWorshipType.addEventListener('change', autoSave);
    }
    if (elements.noteDate) {
        elements.noteDate.addEventListener('change', () => {
            autoSave();
            renderCalendar();
            renderHomeNotes();
        });
    }
}

function updatePenUI(mode) {
    if (!state.penSettings) {
        state.penSettings = {
            pen: { color: '#1e293b', width: 2 },
            highlighter: { color: 'rgba(254, 240, 138, 0.4)', width: 16 }
        };
    }
    if (mode === 'pen' || mode === 'highlighter') {
        const rowId = mode === 'pen' ? 'row-pen-draw-options' : 'row-pen-highlight-options';
        const row = document.getElementById(rowId);
        if (row) {
            const color = state.penSettings[mode].color;
            const width = state.penSettings[mode].width;
            row.querySelectorAll('.pen-color-btn').forEach(b => {
                if (b.dataset.color === color) b.classList.add('active');
                else b.classList.remove('active');
            });
            row.querySelectorAll('.pen-size-btn').forEach(b => {
                if (parseInt(b.dataset.size) === width) b.classList.add('active');
                else b.classList.remove('active');
            });
        }
    }
}

function setupToolbarEvents() {
    const exec = (cmd, val = null) => {
        const activeEd = window._lastActiveEditor || document.querySelector('.sermon-editor');
        if (activeEd) {
            activeEd.focus();
            if (savedSelectionRange) {
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(savedSelectionRange);
            }
        }
        document.execCommand(cmd, false, val);
        if (activeEd) activeEd.focus();
        autoSave();
    };

    const menuTimers = {};
    const autoCloseMenu = (panelId, btnId, delay) => {
        if (menuTimers[panelId]) clearTimeout(menuTimers[panelId]);
        menuTimers[panelId] = setTimeout(() => {
            const panel = document.getElementById(panelId);
            const btn = btnId ? document.getElementById(btnId) : null;
            if (panel && panel.style.display !== 'none') {
                panel.style.display = 'none';
                if (btn) btn.classList.remove('active');
            }
        }, delay);
    };

    const attachMenuReset = (panelId, btnId, delay) => {
        const panel = document.getElementById(panelId);
        if (panel) {
            panel.addEventListener('click', () => autoCloseMenu(panelId, btnId, delay));
            panel.addEventListener('touchstart', () => autoCloseMenu(panelId, btnId, delay), {passive: true});
        }
    };
    
    attachMenuReset('text-format-panel', 'btn-text-toggle', 15000);
    attachMenuReset('notepen-format-panel', 'btn-notepen-toggle', 15000);
    attachMenuReset('row-pen-draw-options', 'btn-pen-draw-toggle', 15000);
    attachMenuReset('row-pen-highlight-options', 'btn-pen-highlight-toggle', 15000);
    attachMenuReset('row-pen-eraser-options', 'btn-pen-eraser', 15000);

    // === 글씨 토글 버튼 ===
    const btnTextToggle = document.getElementById('btn-text-toggle');
    const textFormatPanel = document.getElementById('text-format-panel');
    const btnNotepenToggle = document.getElementById('btn-notepen-toggle');
    const notepenFormatPanel = document.getElementById('notepen-format-panel');
    const btnPenDrawToggle = document.getElementById('btn-pen-draw-toggle');
    const rowPenDrawOptions = document.getElementById('row-pen-draw-options');
    const btnPenHighlightToggle = document.getElementById('btn-pen-highlight-toggle');
    const rowPenHighlightOptions = document.getElementById('row-pen-highlight-options');
    const btnPenEraser = document.getElementById('btn-pen-eraser');
    const rowPenEraserOptions = document.getElementById('row-pen-eraser-options');

    const disableAllPenModes = () => {
        if (rowPenDrawOptions) rowPenDrawOptions.style.display = 'none';
        if (btnPenDrawToggle) btnPenDrawToggle.classList.remove('active');
        if (rowPenHighlightOptions) rowPenHighlightOptions.style.display = 'none';
        if (btnPenHighlightToggle) btnPenHighlightToggle.classList.remove('active');
        if (rowPenEraserOptions) rowPenEraserOptions.style.display = 'none';
        if (btnPenEraser) btnPenEraser.classList.remove('active');
    };

    window.closeTextFormatPanel = () => {
        if (textFormatPanel) textFormatPanel.style.display = 'none';
        if (btnTextToggle) btnTextToggle.classList.remove('active');
        const rowColorFont = document.getElementById('row-color-font');
        const rowColorHighlight = document.getElementById('row-color-highlight');
        const rowFontSizeMain = document.getElementById('row-font-size-main');
        const rowFontFamilyOptions = document.getElementById('row-font-family-options');
        if (rowColorFont) rowColorFont.style.display = 'none';
        if (rowColorHighlight) rowColorHighlight.style.display = 'none';
        if (rowFontSizeMain) rowFontSizeMain.style.display = 'none';
        if (rowFontFamilyOptions) rowFontFamilyOptions.style.display = 'none';
    };

    window.closeNotepenFormatPanel = () => {
        if (notepenFormatPanel) notepenFormatPanel.style.display = 'none';
        if (btnNotepenToggle) btnNotepenToggle.classList.remove('active');
        disableAllPenModes();
    };

    window.closePageStylePanel = () => {
        const panelPageStyle = document.getElementById('page-style-panel');
        const btnPageStyle = document.getElementById('btn-page-style');
        if (panelPageStyle) panelPageStyle.style.display = 'none';
        if (btnPageStyle) btnPageStyle.classList.remove('active');
        const rowBgColor = document.getElementById('row-bg-color');
        const rowLineStyle = document.getElementById('row-line-style');
        const rowLineHeight = document.getElementById('row-line-height');
        const btnBgColorToggle = document.getElementById('btn-bg-color-toggle');
        const btnLineStyleToggle = document.getElementById('btn-line-style-toggle');
        const btnLineHeightToggle = document.getElementById('btn-line-height-toggle');
        if (rowBgColor) rowBgColor.style.display = 'none';
        if (rowLineStyle) rowLineStyle.style.display = 'none';
        if (rowLineHeight) rowLineHeight.style.display = 'none';
        if (btnBgColorToggle) btnBgColorToggle.classList.remove('active');
        if (btnLineStyleToggle) btnLineStyleToggle.classList.remove('active');
        if (btnLineHeightToggle) btnLineHeightToggle.classList.remove('active');
    };
    
    if (btnTextToggle && textFormatPanel) {
        btnTextToggle.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            // ✅ FIX #1: 스크롤 위치 보존
            preserveEditorScroll(() => {
                const isActive = btnTextToggle.classList.contains('active');
                
                if (isActive) {
                    // 이미 열려있으면 닫기
                    textFormatPanel.style.display = 'none';
                    btnTextToggle.classList.remove('active');
                } else {
                    // 닫혀있으면 열기
                    textFormatPanel.style.display = 'flex';
                    btnTextToggle.classList.add('active');
                    autoCloseMenu('text-format-panel', 'btn-text-toggle', 15000);
                    
                    // 노트펜 및 배경 패널 닫기
                    if (notepenFormatPanel) notepenFormatPanel.style.display = 'none';
                    if (btnNotepenToggle) btnNotepenToggle.classList.remove('active');
                    const panelPageStyle = document.getElementById('page-style-panel');
                    const btnPageStyle = document.getElementById('btn-page-style');
                    if (panelPageStyle) panelPageStyle.style.display = 'none';
                    if (btnPageStyle) btnPageStyle.classList.remove('active');
                    
                    // 펜 모드 패널 닫기
                    disableAllPenModes();
                    if (typeof disablePenMode === 'function') disablePenMode();
                }
            });
        };
    }
    
    if (btnNotepenToggle && notepenFormatPanel) {
        btnNotepenToggle.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isActive = btnNotepenToggle.classList.contains('active');
            
            if (isActive) {
                // 이미 열려있으면 닫기 + 펜 모드 종료
                notepenFormatPanel.style.display = 'none';
                btnNotepenToggle.classList.remove('active');
                disableAllPenModes();
                if (typeof disablePenMode === 'function') disablePenMode();
            } else {
                // 닫혀있으면 열기 + 즉시 펜쓰기 모드 활성화
                notepenFormatPanel.style.display = 'flex';
                btnNotepenToggle.classList.add('active');
                autoCloseMenu('notepen-format-panel', 'btn-notepen-toggle', 15000);
                
                // 글씨 및 배경 패널 닫기
                if (textFormatPanel) textFormatPanel.style.display = 'none';
                if (btnTextToggle) btnTextToggle.classList.remove('active');
                const panelPageStyle = document.getElementById('page-style-panel');
                const btnPageStyle = document.getElementById('btn-page-style');
                if (panelPageStyle) panelPageStyle.style.display = 'none';
                if (btnPageStyle) btnPageStyle.classList.remove('active');
                
                // 기본 펜쓰기 모드로 설정 후 즉시 활성화
                state.penMode = state.penMode || 'pen';
                state.isEraser = false;
                updatePenUI(state.penMode);
                if (typeof enablePenMode === 'function') enablePenMode();
                
                // 펜쓰기 버튼 active 표시
                if (state.penMode === 'pen') {
                    if (btnPenDrawToggle) btnPenDrawToggle.classList.add('active');
                    if (rowPenDrawOptions) rowPenDrawOptions.style.display = 'none'; // 처음에 숨김
                    if (btnPenHighlightToggle) btnPenHighlightToggle.classList.remove('active');
                    if (rowPenHighlightOptions) rowPenHighlightOptions.style.display = 'none';
                    if (btnPenEraser) btnPenEraser.classList.remove('active');
                    if (rowPenEraserOptions) rowPenEraserOptions.style.display = 'none';
                } else if (state.penMode === 'highlighter') {
                    if (btnPenHighlightToggle) btnPenHighlightToggle.classList.add('active');
                    if (rowPenHighlightOptions) rowPenHighlightOptions.style.display = 'none';
                    if (btnPenDrawToggle) btnPenDrawToggle.classList.remove('active');
                    if (rowPenDrawOptions) rowPenDrawOptions.style.display = 'none';
                    if (btnPenEraser) btnPenEraser.classList.remove('active');
                    if (rowPenEraserOptions) rowPenEraserOptions.style.display = 'none';
                } else if (state.penMode === 'eraser') {
                    if (btnPenEraser) btnPenEraser.classList.add('active');
                    if (rowPenEraserOptions) rowPenEraserOptions.style.display = 'none';
                    if (btnPenDrawToggle) btnPenDrawToggle.classList.remove('active');
                    if (rowPenDrawOptions) rowPenDrawOptions.style.display = 'none';
                    if (btnPenHighlightToggle) btnPenHighlightToggle.classList.remove('active');
                    if (rowPenHighlightOptions) rowPenHighlightOptions.style.display = 'none';
                }
            }
        };
    }

    if (btnPenDrawToggle) {
        btnPenDrawToggle.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isActive = btnPenDrawToggle.classList.contains('active');
            
            if (isActive) {
                // 이미 활성화된 상태면 펼치기 토글
                const isShowing = rowPenDrawOptions.style.display === 'flex';
                rowPenDrawOptions.style.display = isShowing ? 'none' : 'flex';
            } else {
                disableAllPenModes();
                rowPenDrawOptions.style.display = 'flex';
                btnPenDrawToggle.classList.add('active');
                autoCloseMenu('row-pen-draw-options', 'btn-pen-draw-toggle', 15000);
                state.isEraser = false;
                state.penMode = 'pen';
                updatePenUI('pen');
                if (typeof enablePenMode === 'function') enablePenMode();
                
                // 글씨 패널이 열려있다면 닫기
                if (textFormatPanel) {
                    textFormatPanel.style.display = 'none';
                    if (btnTextToggle) btnTextToggle.classList.remove('active');
                }
            }
        };
    }

    if (btnPenHighlightToggle) {
        btnPenHighlightToggle.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isActive = btnPenHighlightToggle.classList.contains('active');
            
            if (isActive) {
                // 이미 활성화된 상태면 펼치기 토글
                const isShowing = rowPenHighlightOptions.style.display === 'flex';
                rowPenHighlightOptions.style.display = isShowing ? 'none' : 'flex';
            } else {
                disableAllPenModes();
                rowPenHighlightOptions.style.display = 'flex';
                btnPenHighlightToggle.classList.add('active');
                autoCloseMenu('row-pen-highlight-options', 'btn-pen-highlight-toggle', 15000);
                state.isEraser = false;
                state.penMode = 'highlighter';
                updatePenUI('highlighter');
                if (typeof enablePenMode === 'function') enablePenMode();
                
                if (textFormatPanel) {
                    textFormatPanel.style.display = 'none';
                    if (btnTextToggle) btnTextToggle.classList.remove('active');
                }
            }
        };
    }

    if (btnPenEraser) {
        btnPenEraser.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isActive = btnPenEraser.classList.contains('active');
            
            if (isActive) {
                // 이미 활성화된 상태면 펼치기 토글
                const isShowing = rowPenEraserOptions && rowPenEraserOptions.style.display === 'flex';
                if (rowPenEraserOptions) rowPenEraserOptions.style.display = isShowing ? 'none' : 'flex';
            } else {
                disableAllPenModes();
                if (rowPenEraserOptions) {
                    rowPenEraserOptions.style.display = 'flex';
                    autoCloseMenu('row-pen-eraser-options', 'btn-pen-eraser', 15000);
                }
                btnPenEraser.classList.add('active');
                state.isEraser = true;
                state.penMode = 'eraser';
                if (typeof enablePenMode === 'function') enablePenMode();
                
                if (textFormatPanel) {
                    textFormatPanel.style.display = 'none';
                    if (btnTextToggle) btnTextToggle.classList.remove('active');
                }
            }
        };
    }

    const btnBold = document.getElementById('btn-bold');
    if (btnBold) btnBold.onclick = () => { exec('bold'); if (typeof window.closeTextFormatPanel === 'function') window.closeTextFormatPanel(); };
    
    const btnItalic = document.getElementById('btn-italic');
    if (btnItalic) btnItalic.onclick = () => { exec('italic'); if (typeof window.closeTextFormatPanel === 'function') window.closeTextFormatPanel(); };
    
    

    // === 폰트 크기 토글 버튼 ===
    const btnFontSizeToggle = document.getElementById('btn-font-size-toggle');
    const rowFontSizeMain = document.getElementById('row-font-size-main');
    const rowFontSizeDefault = document.getElementById('row-font-size-default');
    const rowFontSizeIndiv = document.getElementById('row-font-size-indiv');
    const displayFontSize = document.getElementById('current-font-size-display');
    const btnFsModeToggle = document.getElementById('btn-fs-mode-toggle');
    const rowFontFamilyOptions = document.getElementById('row-font-family-options');

    if (btnFontSizeToggle && rowFontSizeMain) {
        btnFontSizeToggle.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            // ✅ FIX #1: 스크롤 위치 보존
            preserveEditorScroll(() => {
                const isShowing = rowFontSizeMain.style.display === 'flex';
                rowFontSizeMain.style.display = isShowing ? 'none' : 'flex';
                
                // Show default row by default
                if (!isShowing) {
                    if (rowFontSizeDefault) rowFontSizeDefault.style.display = 'flex';
                    if (rowFontSizeIndiv) rowFontSizeIndiv.style.display = 'none';
                    if (btnFsModeToggle) {
                        btnFsModeToggle.textContent = '개별';
                        btnFsModeToggle.classList.remove('active');
                    }
                } else {
                    if (rowFontFamilyOptions) rowFontFamilyOptions.style.display = 'none';
                }
            });
        });
    }

    if (btnFsModeToggle) {
        btnFsModeToggle.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            const isIndiv = rowFontSizeIndiv && rowFontSizeIndiv.style.display === 'flex';
            if (isIndiv) {
                // Switch to default mode
                if (rowFontSizeIndiv) rowFontSizeIndiv.style.display = 'none';
                if (rowFontSizeDefault) rowFontSizeDefault.style.display = 'flex';
                btnFsModeToggle.textContent = '개별';
                btnFsModeToggle.classList.remove('active');
            } else {
                // Switch to indiv mode
                if (rowFontSizeDefault) rowFontSizeDefault.style.display = 'none';
                if (rowFontSizeIndiv) rowFontSizeIndiv.style.display = 'flex';
                btnFsModeToggle.textContent = '전체';
                btnFsModeToggle.classList.add('active');
            }
        });
    }

    // 전체 기본 폰트 크기 변경 (전체 에디터에 적용)
    document.querySelectorAll('.default-fs-btn').forEach(btn => {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            const size = parseInt(btn.dataset.size);
            document.querySelectorAll('.default-fs-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if(displayFontSize) displayFontSize.textContent = size;
            state.fontSize = size;
            localStorage.setItem('app_font_size', state.fontSize);
            localStorage.setItem('app_font_size_changed_at', Date.now().toString());
            applyFontSize();
            saveToStorage();
            if (typeof debouncedSyncToFirestore === 'function') debouncedSyncToFirestore();
            // 선택 시 글씨 서식 패널 즉시 접기
            if (typeof window.closeTextFormatPanel === 'function') window.closeTextFormatPanel();
        });
    });

    // 개별 적용 폰트 크기 변경 (선택된 텍스트에만 적용)
    document.querySelectorAll('.indiv-fs-btn').forEach(btn => {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            const val = btn.dataset.size; // HTML fontSize value (3~7)
            
            // 현재 포커스된 에디터 찾기
            const focusedEditor = window._lastActiveEditor || document.querySelector('.sermon-editor');
            if (focusedEditor) {
                focusedEditor.focus();
                if (savedSelectionRange) {
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(savedSelectionRange);
                }
            }
            document.execCommand('fontSize', false, val);
            if (focusedEditor) focusedEditor.focus();
            autoSave();
            // 선택 시 글씨 서식 패널 즉시 접기
            if (typeof window.closeTextFormatPanel === 'function') window.closeTextFormatPanel();
        });
    });

    // === 글꼴 토글 버튼 ===
    const btnFontFamilyToggle = document.getElementById('btn-font-family-toggle');
    const displayFontFamily = document.getElementById('current-font-family-display');
    
    if (btnFontFamilyToggle && rowFontFamilyOptions) {
        btnFontFamilyToggle.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            // ✅ FIX #1: 스크롤 위치 보존
            preserveEditorScroll(() => {
                const isShowing = rowFontFamilyOptions.style.display === 'flex';
                rowFontFamilyOptions.style.display = isShowing ? 'none' : 'flex';
                
                if (!isShowing) {
                    if (rowFontSizeMain) rowFontSizeMain.style.display = 'none';
                    if (rowFontSizeDefault) rowFontSizeDefault.style.display = 'none';
                    if (rowFontSizeIndiv) rowFontSizeIndiv.style.display = 'none';
                    if (btnFsDefaultToggle) btnFsDefaultToggle.classList.remove('active');
                    if (btnFsIndivToggle) btnFsIndivToggle.classList.remove('active');
                }
            });
        });
    }

    document.querySelectorAll('.ff-btn').forEach(btn => {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            const family = btn.dataset.family;
            document.querySelectorAll('.ff-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if(displayFontFamily) displayFontFamily.textContent = btn.textContent;
            
            const editor = window._lastActiveEditor || document.querySelector('.sermon-editor');
            if (editor) {
                editor.focus();
                if (savedSelectionRange) {
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(savedSelectionRange);
                }
            }
            document.execCommand('styleWithCSS', false, true);
            document.execCommand('fontName', false, family);
            if (editor) editor.focus();
            autoSave();
            // 선택 시 글씨 서식 패널 즉시 접기
            if (typeof window.closeTextFormatPanel === 'function') window.closeTextFormatPanel();
        });
    });

    // Color Expand Toggle
    const btnColorToggle = document.getElementById('btn-color-toggle');
    const rowColorFont = document.getElementById('row-color-font');
    const btnHighlightToggle = document.getElementById('btn-highlight-toggle');
    const rowColorHighlight = document.getElementById('row-color-highlight');

    if (btnColorToggle && rowColorFont) {
        btnColorToggle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // ✅ FIX #1: 스크롤 위치 보존
            preserveEditorScroll(() => {
                const isShowing = rowColorFont.style.display === 'flex';
                rowColorFont.style.display = isShowing ? 'none' : 'flex';
                if (!isShowing && rowColorHighlight) rowColorHighlight.style.display = 'none';
            });
        });
    }

    if (btnHighlightToggle && rowColorHighlight) {
        btnHighlightToggle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // ✅ FIX #1: 스크롤 위치 보존
            preserveEditorScroll(() => {
                const isShowing = rowColorHighlight.style.display === 'flex';
                rowColorHighlight.style.display = isShowing ? 'none' : 'flex';
                if (!isShowing && rowColorFont) rowColorFont.style.display = 'none';
            });
        });
    }

    // New popup logic
    const btnMoreOptions = document.getElementById('editor-more-options');
    const menuMoreOptions = document.getElementById('editor-more-menu');
    if (btnMoreOptions && menuMoreOptions) {
        btnMoreOptions.onclick = (e) => {
            e.stopPropagation();
            menuMoreOptions.style.display = menuMoreOptions.style.display === 'none' ? 'flex' : 'none';
        };
    }



    const btnPageStyle = document.getElementById('btn-page-style');
    const panelPageStyle = document.getElementById('page-style-panel');
    let pageStyleTimer = null;
    const resetPageStyleTimer = () => {
        if (pageStyleTimer) clearTimeout(pageStyleTimer);
        pageStyleTimer = setTimeout(() => {
            if (panelPageStyle && panelPageStyle.style.display !== 'none') {
                panelPageStyle.style.display = 'none';
                if (btnPageStyle) btnPageStyle.classList.remove('active');
            }
        }, 10000);
    };

    if (btnPageStyle && panelPageStyle) {
        panelPageStyle.addEventListener('click', resetPageStyleTimer);
        panelPageStyle.addEventListener('touchstart', resetPageStyleTimer, {passive: true});

        const _pageStyleToggle = (e) => {
            e.stopPropagation();
            const isOpen = panelPageStyle.style.display !== 'none' && panelPageStyle.style.display !== '';
            if (isOpen) {
                panelPageStyle.style.display = 'none';
                if (btnPageStyle) btnPageStyle.classList.remove('active');
                if (pageStyleTimer) clearTimeout(pageStyleTimer);
            } else {
                panelPageStyle.style.display = 'flex';
                if (btnPageStyle) btnPageStyle.classList.add('active');
                resetPageStyleTimer();
                
                // 글씨 및 노트펜 패널 닫기
                const textFormatPanel = document.getElementById('text-format-panel');
                const btnTextToggle = document.getElementById('btn-text-toggle');
                const notepenFormatPanel = document.getElementById('notepen-format-panel');
                const btnNotepenToggle = document.getElementById('btn-notepen-toggle');
                if (textFormatPanel) textFormatPanel.style.display = 'none';
                if (btnTextToggle) btnTextToggle.classList.remove('active');
                if (notepenFormatPanel) notepenFormatPanel.style.display = 'none';
                if (btnNotepenToggle) btnNotepenToggle.classList.remove('active');

                // 열릴 때 아래 3 버튼 모두 안 펼쳐진 상태로 초기화
                const rowBgColor = document.getElementById('row-bg-color');
                const rowLineStyle = document.getElementById('row-line-style');
                const rowLineHeight = document.getElementById('row-line-height');
                const btnBgColorToggle = document.getElementById('btn-bg-color-toggle');
                const btnLineStyleToggle = document.getElementById('btn-line-style-toggle');
                const btnLineHeightToggle = document.getElementById('btn-line-height-toggle');
                if (rowBgColor) rowBgColor.style.display = 'none';
                if (rowLineStyle) rowLineStyle.style.display = 'none';
                if (rowLineHeight) rowLineHeight.style.display = 'none';
                if (btnBgColorToggle) btnBgColorToggle.classList.remove('active');
                if (btnLineStyleToggle) btnLineStyleToggle.classList.remove('active');
                if (btnLineHeightToggle) btnLineHeightToggle.classList.remove('active');
            }
        };
        btnPageStyle.onclick = _pageStyleToggle;
        btnPageStyle.addEventListener('touchend', (e) => { e.preventDefault(); _pageStyleToggle(e); });
    }

    const btnBgColorToggle = document.getElementById('btn-bg-color-toggle');
    const rowBgColor = document.getElementById('row-bg-color');
    const btnLineStyleToggle = document.getElementById('btn-line-style-toggle');
    const rowLineStyle = document.getElementById('row-line-style');
    const btnLineHeightToggle = document.getElementById('btn-line-height-toggle');
    const rowLineHeight = document.getElementById('row-line-height');

    const togglePanelRow = (btn, row) => {
        const isShowing = row.style.display === 'flex';
        [rowBgColor, rowLineStyle, rowLineHeight].forEach(r => { if(r) r.style.display = 'none'; });
        [btnBgColorToggle, btnLineStyleToggle, btnLineHeightToggle].forEach(b => { if(b) b.classList.remove('active'); });
        if(!isShowing) {
            row.style.display = 'flex';
            btn.classList.add('active');
        }
    };

    if (btnBgColorToggle) {
        const _bgToggle = (e) => { e.preventDefault(); e.stopPropagation(); togglePanelRow(btnBgColorToggle, rowBgColor); };
        btnBgColorToggle.onclick = _bgToggle;
        btnBgColorToggle.addEventListener('touchend', _bgToggle);
    }
    if (btnLineStyleToggle) {
        const _lineToggle = (e) => { e.preventDefault(); e.stopPropagation(); togglePanelRow(btnLineStyleToggle, rowLineStyle); };
        btnLineStyleToggle.onclick = _lineToggle;
        btnLineStyleToggle.addEventListener('touchend', _lineToggle);
    }
    if (btnLineHeightToggle) {
        const _heightToggle = (e) => { e.preventDefault(); e.stopPropagation(); togglePanelRow(btnLineHeightToggle, rowLineHeight); };
        btnLineHeightToggle.onclick = _heightToggle;
        btnLineHeightToggle.addEventListener('touchend', _heightToggle);
    }

    // Custom pinch-to-zoom for editor
    if (document.querySelector('.sermon-editor')) {
        let initialPinchDistance = null;
        let initialFontSize = null;

        document.querySelector('.sermon-editor').addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                initialPinchDistance = Math.hypot(dx, dy);
                initialFontSize = state.fontSize;
            }
        }, { passive: true });

        document.querySelector('.sermon-editor').addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && initialPinchDistance) {
                // Prevent default scrolling when zooming
                e.preventDefault();
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const currentDistance = Math.hypot(dx, dy);
                
                const ratio = currentDistance / initialPinchDistance;
                let newSize = Math.round(initialFontSize * ratio);
                
                if (newSize < 12) newSize = 12;
                if (newSize > 60) newSize = 60;
                
                if (state.fontSize !== newSize) {
                    state.fontSize = newSize;
                    localStorage.setItem('app_font_size', newSize.toString());
                    applyFontSize();
                }
            }
        }, { passive: false });

        document.querySelector('.sermon-editor').addEventListener('touchend', (e) => {
            if (e.touches.length < 2) {
                initialPinchDistance = null;
            }
        });
    }

    // Close palettes and menus on outside click
    window.addEventListener('click', (e) => {
        const p = document.getElementById('palette-color');
        const h = document.getElementById('palette-highlight');
        if (p) p.classList.remove('show');
        if (h) h.classList.remove('show');
        
        if (menuMoreOptions && !menuMoreOptions.contains(e.target) && e.target !== btnMoreOptions) {
            menuMoreOptions.style.display = 'none';
        }
    });
    // API Settings Logic
    const apiSettingsBtn = document.getElementById('api-settings-btn');
    const apiSettingsModal = document.getElementById('api-settings-modal');
    const closeApiSettings = document.getElementById('close-api-settings');
    const saveApiSettings = document.getElementById('save-api-settings');
    const inputGeminiKey = document.getElementById('input-gemini-key');

    if (apiSettingsBtn) {
        apiSettingsBtn.onclick = () => {
            const key = localStorage.getItem('gemini_api_key') || '';
            if (inputGeminiKey) inputGeminiKey.value = key;
            if (apiSettingsModal) apiSettingsModal.classList.add('active');
        };
    }
    if (closeApiSettings) closeApiSettings.onclick = () => apiSettingsModal.classList.remove('active');
    if (saveApiSettings) {
        saveApiSettings.onclick = async () => {
            const key = inputGeminiKey ? inputGeminiKey.value.trim() : '';
            localStorage.setItem('gemini_api_key', key);
            
            if (db && key) {
                try {
                    await db.collection('users').doc('_ADMIN_CONFIG_').set({ gemini_api_key: key }, { merge: true });
                } catch(e) {
                    console.error('클라우드 저장 실패', e);
                }
            }
            
            if (apiSettingsModal) apiSettingsModal.classList.remove('active');
            showToast('API 키가 서버에 저장되어 모든 사용자가 쓸 수 있습니다.');
        };
    }

    // Summary Button - AI Summarization via Gemini
    const btnSummary = document.getElementById('summary-btn');
    if (btnSummary) {
        btnSummary.onclick = async () => {
            const text = document.querySelector('.sermon-editor').innerText.trim();
            if (!text) { showToast('내용이 없습니다.', 'warning'); return; }
            
            let apiKey = localStorage.getItem('gemini_api_key');
            if (!apiKey && db) {
                try {
                    showToast('서버에서 공용 API 키를 가져오는 중...', 'info', 2000);
                    const doc = await db.collection('users').doc('_ADMIN_CONFIG_').get();
                    if (doc.exists && doc.data().gemini_api_key) {
                        apiKey = doc.data().gemini_api_key;
                        localStorage.setItem('gemini_api_key', apiKey);
                    }
                } catch(e) {
                    console.warn('공용 API 키를 가져올 수 없습니다.', e);
                    showToast('서버 접속 실패: ' + e.message, 'error', 3000);
                }
            }

            if (!apiKey) {
                showToast('API 키가 필요합니다. 관리자 설정을 확인해주세요.', 'warning');
                if (apiSettingsModal) apiSettingsModal.classList.add('active');
                return;
            }

            // Show loading overlay
            const summaryOverlay = document.getElementById('summary-loading-overlay');
            if (summaryOverlay) summaryOverlay.style.display = 'flex';
            btnSummary.disabled = true;

            try {
                // 모델 자동 탐색 (사용 가능한 모델 찾기)
                let targetModel = 'gemini-1.5-flash';
                try {
                    const modelsResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                    if (modelsResp.ok) {
                        const modelsData = await modelsResp.json();
                        const availableModels = modelsData.models || [];
                        
                        // 선호하는 모델 순서
                        const preferred = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro', 'gemini-pro'];
                        for (const pref of preferred) {
                            const found = availableModels.find(m => m.name.includes(pref) && (m.supportedGenerationMethods || []).includes('generateContent'));
                            if (found) {
                                targetModel = found.name.replace('models/', '');
                                break;
                            }
                        }
                    }
                } catch(e) {
                    console.warn('모델 탐색 실패, 기본값 사용', e);
                }

                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: "다음 설교 내용을 3~4개의 핵심 포인트로 나누어, 각 줄 앞에 1., 2., 3. 처럼 숫자를 붙여서 한눈에 알아보기 쉽게 요약해줘:\n\n" + text }] }]
                    })
                });

                if (!response.ok) {
                    let errorMsg = 'API 요청 실패 (키 오류 등)';
                    try {
                        const errorData = await response.json();
                        if (errorData.error && errorData.error.message) {
                            errorMsg += `\n원인: ${errorData.error.message}`;
                        } else {
                            errorMsg += `\n상태 코드: ${response.status}`;
                        }
                    } catch(e) {
                        errorMsg += `\n상태 코드: ${response.status}`;
                    }
                    throw new Error(errorMsg);
                }

                const data = await response.json();
                let summary = "";
                if (data.candidates && data.candidates[0] && data.candidates[0].content) {
                    summary = data.candidates[0].content.parts.map(p => p.text).join('\n').trim();
                }

                if (!summary) throw new Error('요약 결과를 받지 못했습니다.');

                if (state.currentNoteId && state.notes[state.currentNoteId]) {
                    state.notes[state.currentNoteId].summary = summary;
                    saveToStorage();
                    if (typeof syncToFirestore === 'function') syncToFirestore();
                }
                
                const summaryModal = document.getElementById('summary-modal');
                const summaryContent = document.getElementById('summary-content');
                if (summaryModal && summaryContent) {
                    summaryContent.innerHTML = summary.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
                    summaryModal.classList.add('active');
                }
                // Also trigger re-render of home notes if they are visible
                renderHomeNotes();
                renderWorshipTypes();
            } catch (err) {
                console.error(err);
                showToast(err.message, 'error');
            } finally {
                btnSummary.disabled = false;
                // Hide loading overlay
                const summaryOverlay = document.getElementById('summary-loading-overlay');
                if (summaryOverlay) summaryOverlay.style.display = 'none';
            }
        };
    }
    
    // Summary modal close logic
    const closeSummaryModal = () => {
        const sm = document.getElementById('summary-modal');
        if (sm) sm.classList.remove('active');
    };
    const csmBtn = document.getElementById('close-summary-modal');
    if (csmBtn) csmBtn.onclick = closeSummaryModal;
    const okSmBtn = document.getElementById('summary-ok-btn');
    if (okSmBtn) okSmBtn.onclick = closeSummaryModal;

    const shareSmBtn = document.getElementById('summary-share-btn');
    if (shareSmBtn) {
        shareSmBtn.onclick = async () => {
            if (!state.currentNoteId) return;
            const note = state.notes[state.currentNoteId];
            if (!note) return;
            
            let summaryText = note.summary;
            if (!summaryText && note.content) {
                const temp = document.createElement('div');
                temp.innerHTML = note.content;
                const b = temp.querySelector('.summary-block');
                if (b) summaryText = b.textContent;
            }
            if (!summaryText) return;
            
            // Clean up Markdown for sharing
            const cleanSummary = summaryText.replace(/\*\*(.*?)\*\*/g, '$1');
            const shareContent = `[설교 요약] ${note.title || '제목 없음'}\n\n${cleanSummary}`;
            
            if (navigator.share) {
                try {
                    await navigator.share({
                        title: note.title || '설교 요약',
                        text: shareContent
                    });
                } catch (e) {
                    console.log("Share failed:", e);
                }
            } else {
                try {
                    await navigator.clipboard.writeText(shareContent);
                    showToast('요약이 클립보드에 복사되었습니다.');
                } catch (e) {
                    showToast('공유 기능을 지원하지 않는 환경입니다.', 'error');
                }
            }
        };
    }

    // Summary show logic
    window.showSummary = (noteId) => {
        if (!noteId) return;
        const note = state.notes[noteId];
        if (!note) return;
        
        state.currentNoteId = noteId;
        const summaryData = note.summary || (note.content ? (() => { const temp = document.createElement('div'); temp.innerHTML = note.content; const b = temp.querySelector('.summary-block'); return b ? b.textContent : null; })() : null);
        
        if (summaryData) {
            const summaryModal = document.getElementById('summary-modal');
            const summaryContent = document.getElementById('summary-content');
            if (summaryModal && summaryContent) {
                summaryContent.innerHTML = summaryData.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
                summaryModal.classList.add('active');
            }
        }
    };

    // Summary delete logic
    window.deleteSummary = (noteId) => {
        if (!noteId) noteId = state.currentNoteId;
        if (noteId && state.notes[noteId]) {
            // Delete AI summary property completely
            state.notes[noteId].summary = null;
            
            // Delete legacy embedded summary-block from content
            if (state.notes[noteId].content) {
                const temp = document.createElement('div');
                temp.innerHTML = state.notes[noteId].content;
                const blocks = temp.querySelectorAll('.summary-block');
                if (blocks.length > 0) {
                    blocks.forEach(b => b.remove());
                    state.notes[noteId].content = temp.innerHTML;
                    
                    // Update editor if the deleted note is currently open
                    if (state.currentNoteId === noteId) {
                        const contentEl = document.querySelector('.sermon-editor');
                        if (contentEl) contentEl.innerHTML = temp.innerHTML;
                    }
                }
            }
            
            saveToStorage();
            if (typeof syncToFirestore === 'function') syncToFirestore();
            showToast('요약이 삭제되었습니다.');
            renderHomeNotes();
            renderWorshipTypes();
            closeSummaryModal();
        }
    };
    const delSmBtn = document.getElementById('summary-delete-btn');
    if (delSmBtn) delSmBtn.onclick = () => window.deleteSummary();

    // Color Swatches (Directly accessible)
    document.querySelectorAll('.direct-swatch').forEach(swatch => {
        const handleSwatchClick = (e) => {
            e.preventDefault(); // prevents editor from losing focus
            e.stopPropagation();
            const cmd = swatch.dataset.cmd;
            const color = swatch.dataset.color;
            
            const editor = window._lastActiveEditor || document.querySelector('.sermon-editor');
            if (editor) {
                editor.focus();
                if (savedSelectionRange) {
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(savedSelectionRange);
                }
            }
            
            if (cmd === 'backColor' && (color === 'transparent' || color === 'rgba(0,0,0,0)')) {
                // Remove highlight/background
                document.execCommand('backColor', false, 'rgba(0,0,0,0)');
                document.execCommand('hiliteColor', false, 'rgba(0,0,0,0)'); // for some webkit browsers
            } else {
                // 'backColor' works better for highlights on mobile browsers than 'hiliteColor'
                document.execCommand(cmd, false, color);
            }
            
            if (editor) editor.focus();
            autoSave();

            // 선택 시 글씨 서식 패널 즉시 접기
            if (typeof window.closeTextFormatPanel === 'function') window.closeTextFormatPanel();
        };

        swatch.onmousedown = handleSwatchClick;
        swatch.addEventListener('pointerdown', handleSwatchClick);
    });
}

// 하단부 모든 펼침 메뉴/옵션 일괄 접기 유틸리티 함수
function collapseAllSubPanels() {
    try {
        const rowColorFont = document.getElementById('row-color-font');
        const rowColorHighlight = document.getElementById('row-color-highlight');
        const rowFontSizeMain = document.getElementById('row-font-size-main');
        const rowFontFamilyOptions = document.getElementById('row-font-family-options');
        if (rowColorFont) rowColorFont.style.display = 'none';
        if (rowColorHighlight) rowColorHighlight.style.display = 'none';
        if (rowFontSizeMain) rowFontSizeMain.style.display = 'none';
        if (rowFontFamilyOptions) rowFontFamilyOptions.style.display = 'none';

        const rowPenDrawOptions = document.getElementById('row-pen-draw-options');
        const rowPenHighlightOptions = document.getElementById('row-pen-highlight-options');
        const rowPenEraserOptions = document.getElementById('row-pen-eraser-options');
        if (rowPenDrawOptions) rowPenDrawOptions.style.display = 'none';
        if (rowPenHighlightOptions) rowPenHighlightOptions.style.display = 'none';
        if (rowPenEraserOptions) rowPenEraserOptions.style.display = 'none';

        const rowBgColor = document.getElementById('row-bg-color');
        const rowLineStyle = document.getElementById('row-line-style');
        const rowLineHeight = document.getElementById('row-line-height');
        const btnBgColorToggle = document.getElementById('btn-bg-color-toggle');
        const btnLineStyleToggle = document.getElementById('btn-line-style-toggle');
        const btnLineHeightToggle = document.getElementById('btn-line-height-toggle');
        if (rowBgColor) rowBgColor.style.display = 'none';
        if (rowLineStyle) rowLineStyle.style.display = 'none';
        if (rowLineHeight) rowLineHeight.style.display = 'none';
        if (btnBgColorToggle) btnBgColorToggle.classList.remove('active');
        if (btnLineStyleToggle) btnLineStyleToggle.classList.remove('active');
        if (btnLineHeightToggle) btnLineHeightToggle.classList.remove('active');
    } catch(e) {
        console.warn('collapseAllSubPanels error:', e);
    }
}

// Editor Back to Sermon Notes List (설교/기도노트에서 설교노트 창/목록으로 이동)
function returnToSermonListFromEditor() {
    try {
        if (typeof autoSave === 'function') autoSave();
        if (state.isDrawingMode && typeof disablePenMode === 'function') {
            disablePenMode();
        }
    } catch(e) {
        console.warn('returnToSermonListFromEditor cleanup error:', e);
    }
    openSermonNotesList();
    history.replaceState({ view: 'sermon' }, '', '#sermon');
}

// Editor Back to Home (설교/기도노트에서 메인 홈으로 복귀)
function returnToHomeFromEditor() {
    try {
        if (typeof autoSave === 'function') autoSave();
        if (state.isDrawingMode && typeof disablePenMode === 'function') {
            disablePenMode();
        }
    } catch(e) {
        console.warn('returnToHomeFromEditor cleanup error:', e);
    }
    state.currentNoteId = null;
    showMainHome();
    history.replaceState({ view: 'home' }, '', '#home');
}

// View Switching
let homeScrollPosition = 0;

function switchView(view, pushState = true) {
    if (!elements.homeView || !elements.editorView) {
        updateElementReferences();
    }
    if (state.view === 'home') {
        const homeContent = document.querySelector('.home-content');
        if (homeContent) homeScrollPosition = homeContent.scrollTop;
    }

    if (pushState && state.view !== view) {
        history.pushState({ view: view }, '', '#' + view);
    }
    state.view = view;

    const bibleView = document.getElementById('bible-reader-view');
    const searchView = document.getElementById('bible-search-view');

    if (elements.homeView) {
        elements.homeView.classList.toggle('active', view === 'home');
        elements.homeView.style.display = (view === 'home') ? 'flex' : 'none';
    }
    if (elements.editorView) {
        elements.editorView.classList.toggle('active', view === 'editor');
        elements.editorView.style.display = (view === 'editor') ? 'flex' : 'none';
    }
    if (elements.adminView) {
        elements.adminView.classList.toggle('active', view === 'admin');
        elements.adminView.style.display = (view === 'admin') ? 'flex' : 'none';
    }
    if (bibleView && view !== 'bible') bibleView.style.display = 'none';
    if (searchView && view !== 'search') searchView.style.display = 'none';

    // 탭 바 표시/숨김 관리
    const tabBar = document.getElementById('bottom-tab-bar');
    if (tabBar) {
        if (view === 'editor') {
            tabBar.classList.add('hidden');
        } else if (view === 'home') {
            tabBar.classList.remove('hidden');
        }
    }

    if (view === 'home') {
        renderHomeNotes();
        setTimeout(() => {
            const homeContent = document.querySelector('.home-content');
            if (homeContent) homeContent.scrollTop = homeScrollPosition;
        }, 0);
    }
}

// Note Management
function loadNote(id) {
    try {
        if (!state.notes[id]) return;
        state.currentNoteId = id;
        let note = state.notes[id];
        
        // 노트 데이터가 객체가 아닌 문자열 등으로 손상된 경우 치유(Healing) 로직 적용
        if (typeof note !== 'object' || note === null) {
            note = {
                title: typeof note === 'string' ? note.substring(0, 30) : '복구된 설교',
                pages: [{ content: typeof note === 'string' ? note : '', drawingData: null }],
                worshipType: '주일예배',
                isoDate: new Date().toISOString().split('T')[0],
                timestamp: Date.now()
            };
            state.notes[id] = note;
        }
        
        // 페이지 마이그레이션 (하위호환성 유지)
        if (!note.pages || !Array.isArray(note.pages)) {
            note.pages = [ { content: note.content || '', drawingData: note.drawingData || null } ];
        }
        note.pages = note.pages.filter(p => p !== null && p !== undefined);
        state.currentPageIndex = 0;
        
        // 1. Render all pages first so the DOM elements are created
        renderAllPages(note);
        
        if (elements.titleInput) {
            elements.titleInput.value = note.title || '';
        }
        
        // Set worship type select options and select active value
        populateWorshipTypeSelect(note.worshipType || '주일예배');
        
        // Set date input value
        if (elements.noteDate) {
            let dateVal = '';
            try {
                if (note.isoDate) {
                    dateVal = note.isoDate;
                } else {
                    const ts = (note.timestamp && !isNaN(note.timestamp)) ? note.timestamp : Date.now();
                    dateVal = new Date(ts).toISOString().split('T')[0];
                }
            } catch (e) {
                dateVal = new Date().toISOString().split('T')[0];
            }
            elements.noteDate.value = dateVal;
        }
        
        state.detectedVerses.clear();
        if (elements.verseGallery) {
            elements.verseGallery.innerHTML = '';
        }
        const biblePane = document.getElementById('bible-view');
        if (biblePane) biblePane.classList.remove('has-verses');
        const firstEditor = document.querySelector('.sermon-editor');
        detectBibleReferences(firstEditor ? firstEditor.innerText : '');
        applyBibleFontSize();
        applyFontSize();   // 에디터 DOM이 새로 생성된 후 글자 크기 반드시 재적용
        applyTheme();
        applyAutoInsertUI();
        
        updatePageNavigator();
        initPageObserver();
        switchView('editor');
    } catch (e) {
        console.error("loadNote error:", e);
        showToast("설교 노트를 불러오는 중 오류가 발생했습니다: " + e.message, "error");
    }
}

async function deleteNoteById(idToDelete) {
    if (!idToDelete || !state.notes[idToDelete]) return;
    
    // Remove from local state
    delete state.notes[idToDelete];
    if (!state.deletedNotes.includes(idToDelete)) {
        state.deletedNotes.push(idToDelete);
    }
    
    // Save to local storage
    saveToStorage();
    
    // Explicitly delete from Firestore to prevent merge recovery
    const docId = getIdentityDocId();
    if (db && docId) {
        try {
            await db.collection('users').doc(docId).update({
                [`notes.${idToDelete}`]: firebase.firestore.FieldValue.delete(),
                deletedNotes: firebase.firestore.FieldValue.arrayUnion(idToDelete),
                lastUpdated: Date.now()
            });
        } catch (e) {
            console.error("Firestore Delete Error", e);
            // Fallback if doc doesn't exist
            await syncToFirestore();
        }
    }
    
    showToast('삭제되었습니다.');
    if (state.currentNoteId === idToDelete) {
        state.currentNoteId = null;
        if (history.state && history.state.view === 'editor') {
            history.back();
        } else {
            switchView('home');
        }
    } else {
        renderHomeNotes();
    }
}

async function shareNoteById(idToShare) {
    const note = state.notes[idToShare];
    if (!note) return;

    let textToShare = `${note.title || '제목 없음'}\n${note.date || ''}\n\n`;
    if (note.summary) textToShare += `[요약]\n${note.summary}\n\n`;
    
    // ✅ FIX #6: pages 배열의 모든 내용을 포함하여 공유
    const temp = document.createElement('div');
    if (note.pages && note.pages.length > 0) {
        // 모든 페이지 내용을 합산
        note.pages.forEach((page, idx) => {
            temp.innerHTML = page.content || '';
            const pageText = temp.innerText.replace(/\n{3,}/g, '\n\n').trim();
            if (pageText) {
                if (note.pages.length > 1) textToShare += `[${idx + 1}페이지]\n`;
                textToShare += pageText + '\n\n';
            }
        });
    } else {
        temp.innerHTML = note.content || '';
        const plainTextContent = temp.innerText.replace(/\n{3,}/g, '\n\n');
        textToShare += plainTextContent;
    }

    if (navigator.share) {
        try {
            await navigator.share({
                title: note.title || '설교 노트',
                text: textToShare
            });
        } catch (err) {
            console.error('Share failed:', err);
        }
    } else {
        // Fallback: Copy to clipboard
        try {
            await navigator.clipboard.writeText(textToShare);
            showToast('클립보드에 복사되었습니다.');
        } catch (err) {
            alert('공유 기능을 사용할 수 없습니다.');
        }
    }
}

async function deleteCurrentNote() {
    if (!state.currentNoteId || !state.notes[state.currentNoteId]) return;
    
    if (confirm('이 설교 기록을 지우시겠습니까?')) {
        await deleteNoteById(state.currentNoteId);
    }
}

async function shareCurrentNote() {
    if (!state.currentNoteId || !state.notes[state.currentNoteId]) return;
    saveAllPages();
    const note = state.notes[state.currentNoteId];
    
    let textToShare = `${note.title || '제목 없음'}\n${note.date || ''}\n\n`;
    if (note.summary) textToShare += `[요약]\n${note.summary}\n\n`;
    
    const temp = document.createElement('div');
    if (note.pages && note.pages.length > 0) {
        note.pages.forEach((page, idx) => {
            temp.innerHTML = page.content || '';
            const pageText = temp.innerText.replace(/\n{3,}/g, '\n\n').trim();
            if (pageText) {
                if (note.pages.length > 1) textToShare += `[${idx + 1}페이지]\n`;
                textToShare += pageText + '\n\n';
            }
        });
    } else {
        temp.innerHTML = note.content || '';
        const plainTextContent = temp.innerText.replace(/\n{3,}/g, '\n\n');
        textToShare += plainTextContent;
    }

    if (navigator.share) {
        try {
            await navigator.share({
                title: note.title || '설교 노트',
                text: textToShare
            });
        } catch (e) {
            console.log("공유 실패 또는 취소", e);
        }
    } else {
        try {
            await navigator.clipboard.writeText(textToShare);
            showToast('내용이 클립보드에 복사되었습니다.');
        } catch (e) {
            showToast('공유 기능을 사용할 수 없습니다.');
        }
    }
}

let metaModalMode = 'create'; // 'create' or 'edit'

function createNewNote() {
    // Legacy fallback
    openNoteMetaModal('create');
}

function openNoteMetaModal(mode) {
    metaModalMode = mode;
    const modal = document.getElementById('new-note-modal');
    if (!modal) return;
    
    const titleEl = document.getElementById('meta-modal-title');
    const buttonEl = document.getElementById('save-new-note');
    
    // 1. Set texts based on mode
    if (titleEl) {
        titleEl.textContent = mode === 'create' ? '새 설교 기록 시작' : '설교 정보 수정';
    }
    if (buttonEl) {
        buttonEl.textContent = mode === 'create' ? '기록 시작하기' : '변경사항 저장';
    }
    
    // 2. Populate worship types in modal dropdown
    const typeSelect = document.getElementById('modal-note-worship-type');
    if (typeSelect) {
        typeSelect.innerHTML = '';
        
        // Add default safety option '프로젝트 없음'
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '프로젝트 없음';
        defaultOpt.textContent = '프로젝트 없음';
        typeSelect.appendChild(defaultOpt);
        
        // Find default or current value
        let activeVal = '주일예배';
        if (mode === 'edit' && state.currentNoteId && state.notes[state.currentNoteId]) {
            activeVal = state.notes[state.currentNoteId].worshipType || '프로젝트 없음';
        }
        
        state.worshipTypes.forEach(type => {
            const opt = document.createElement('option');
            opt.value = type;
            opt.textContent = type;
            if (type === activeVal) {
                opt.selected = true;
            }
            typeSelect.appendChild(opt);
        });
        
        if (activeVal === '프로젝트 없음') {
            defaultOpt.selected = true;
        }
    }
    
    // 3. Set date
    const dateInput = document.getElementById('modal-note-date');
    if (dateInput) {
        if (mode === 'edit' && state.currentNoteId && state.notes[state.currentNoteId]) {
            dateInput.value = state.notes[state.currentNoteId].isoDate || new Date().toISOString().split('T')[0];
        } else {
            dateInput.value = new Date().toISOString().split('T')[0];
        }
    }
    
    // 4. Show modal
    modal.classList.add('active');
}

function closeNewNoteModal() {
    const modal = document.getElementById('new-note-modal');
    if (modal) modal.classList.remove('active');
}

function saveNoteMetaFromModal() {
    const typeSelect = document.getElementById('modal-note-worship-type');
    const dateInput = document.getElementById('modal-note-date');
    
    const worshipType = typeSelect ? typeSelect.value : '주일예배';
    const isoDateStr = dateInput && dateInput.value ? dateInput.value : new Date().toISOString().split('T')[0];
    
    // Format date string to Korean locale: YYYY. MM. DD.
    const selectedDate = new Date(isoDateStr);
    const dateStr = selectedDate.toLocaleDateString('ko-KR');
    
    if (metaModalMode === 'create') {
        // Create new note
        const id = 'note_' + Date.now();
        state.notes[id] = {
            title: '',
            pages: [ { content: '', drawingData: null } ],
            date: dateStr,
            isoDate: isoDateStr,
            worshipType: worshipType,
            timestamp: Date.now()
        };
        
        saveToStorage();
        syncToFirestore();
        
        closeNewNoteModal();
        
        if (!state.expandedMonths) state.expandedMonths = [];
        const dateObj = new Date(state.notes[id].timestamp);
        const key = `${dateObj.getFullYear()}-${String(dateObj.getMonth()+1).padStart(2,'0')}`;
        if (!state.expandedMonths.includes(key)) {
            state.expandedMonths.push(key);
        }
        
        loadNote(id);
    } else {
        // Edit existing note
        if (state.currentNoteId && state.notes[state.currentNoteId]) {
            state.notes[state.currentNoteId].worshipType = worshipType;
            state.notes[state.currentNoteId].isoDate = isoDateStr;
            state.notes[state.currentNoteId].date = dateStr;
            
            saveToStorage();
            syncToFirestore();
            showToast('설교 정보가 수정되었습니다.');
        }
        closeNewNoteModal();
        // Render changes on home screen
        renderHomeNotes();
    }
}

function renderHomeNotes() {
    if (!elements.homeNoteList) return;

    // --- Hero: Date & Stats ---
    const dateEl = document.getElementById('home-date');
    const greetingEl = document.getElementById('home-greeting');
    if (dateEl) {
        const now = new Date();
        const days = ['일','월','화','수','목','금','토'];
        dateEl.textContent = `${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일 (${days[now.getDay()]})`;
    }
    if (greetingEl) {
        // The greeting and background are now exclusively handled by fetchWeatherGreeting() and applyWeatherCode()
        // to prevent overwriting the time and weather specific greetings.
    }

    const allNotes = Object.keys(state.notes).map(id => ({ id, ...state.notes[id] }));
    const totalEl = document.getElementById('stat-total');
    const monthEl = document.getElementById('stat-month');
    if (totalEl) totalEl.textContent = allNotes.length;
    if (monthEl) {
        const now = new Date();
        const thisMonth = allNotes.filter(n => {
            const d = new Date(n.timestamp || 0);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }).length;
        monthEl.textContent = thisMonth;
    }

    // 신앙 동행 (방문 이력) 업데이트
    if (typeof updateFaithVisitRecord === 'function') {
        updateFaithVisitRecord();
    }

    // 메인 설교노트 토글 바인딩
    if (typeof initHomeSermonNotesToggle === 'function') {
        initHomeSermonNotesToggle();
    }

    // 메인 액션 카드의 설교노트 수 서브텍스트 업데이트
    const countSubEl = document.getElementById('action-card-note-count');
    if (countSubEl) {
        countSubEl.textContent = allNotes.length > 0
            ? `기록된 설교노트 총 ${allNotes.length}편 (클릭하여 목록 보기)`
            : `작성된 설교노트가 없습니다 (클릭하여 보기)`;
    }

    // 최근 작성한 설교노트 요약
    const latestTitleEl = document.getElementById('stat-latest-title');
    const latestChip = document.getElementById('summary-latest-note-chip');
    if (latestTitleEl && allNotes.length > 0) {
        const sortedNotes = [...allNotes].sort((a,b) => (b.timestamp || 0) - (a.timestamp || 0));
        const latestNote = sortedNotes[0];
        let title = latestNote.title || '제목 없음';
        if (title.length > 7) title = title.substring(0, 6) + '…';
        latestTitleEl.textContent = title;
    } else if (latestTitleEl) {
        latestTitleEl.textContent = '첫 노트 작성';
    }

    // 메인 말씀카드 칩들 클릭 시 설교노트 리스트로 바로 이동
    const chipsToBind = [
        'summary-latest-note-chip',
        'summary-total-chip',
        'summary-month-chip',
        'summary-visit-chip'
    ];
    chipsToBind.forEach(chipId => {
        const chip = document.getElementById(chipId);
        if (chip) {
            chip.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openSermonNotesList();
            };
        }
    });

    // 홈 뷰 모드에 따라 보여줄 내용 결정
    const noteListEl = elements.homeNoteList;
    const worshipListEl = elements.worshipTypeList;
    const viewModeLabel = document.getElementById('home-view-mode-label');
    
    if (state.homeViewMode === 'worship') {
        // 예배별 보기 (기본)
        if (state.homeFilterType && state.homeFilterType !== 'all') {
            // 특정 예배 유형만
            noteListEl.style.display = 'block';
            worshipListEl.style.display = 'none';
            if (viewModeLabel) viewModeLabel.innerHTML = `<i class="fas fa-church"></i> ${state.homeFilterType}`;
            // 특정 예배 유형 카드 렌더링 (filteredNotes 사용)
        } else {
            // 예배별 전체 보기 (worshipTypeList 사용)
            noteListEl.style.display = 'none';
            worshipListEl.style.display = 'block';
            if (viewModeLabel) viewModeLabel.innerHTML = `<i class="fas fa-church"></i> 예배별 보기`;
            renderWorshipTypes();
            // stats 계산 후 return
            const allNotes2 = Object.keys(state.notes).map(id => ({ id, ...state.notes[id] }));
            const totalEl2 = document.getElementById('stat-total');
            const monthEl2 = document.getElementById('stat-month');
            if (totalEl2) totalEl2.textContent = allNotes2.length;
            if (monthEl2) {
                const now2 = new Date();
                monthEl2.textContent = allNotes2.filter(n => {
                    const d = new Date(n.timestamp || 0);
                    return d.getMonth() === now2.getMonth() && d.getFullYear() === now2.getFullYear();
                }).length;
            }
            updateDrawerWorshipBtns();
            return;
        }
    } else {
        // 모두 보기
        noteListEl.style.display = 'block';
        worshipListEl.style.display = 'none';
        if (viewModeLabel) viewModeLabel.innerHTML = `<i class="fas fa-th-list"></i> 모두 보기`;
    }

    // 기존 filter tabs 업데이트 제거 (drawer로 대체)
    // Also keep worship-type-list in sync for backward compat
    updateDrawerWorshipBtns();

    // --- Note Cards ---
    elements.homeNoteList.innerHTML = '';

    // Filter notes by active tab / state
    let activeFilter = 'all';
    if (state.homeViewMode === 'worship' && state.homeFilterType && state.homeFilterType !== 'all') {
        activeFilter = state.homeFilterType;
    } else if (state.homeViewMode === 'all') {
        activeFilter = 'all';
    }

    let filteredNotes = allNotes.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (activeFilter !== 'all') {
        filteredNotes = filteredNotes.filter(n => (n.worshipType || '주일예배') === activeFilter);
    }

    if (filteredNotes.length === 0) {
        elements.homeNoteList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-book-open"></i></div>
                <div class="empty-state-title">아직 기록된 설교가 없습니다</div>
                <div class="empty-state-desc">오른쪽 하단의 <strong>+</strong> 버튼을 눌러<br>첫 설교를 기록해 보세요!</div>
            </div>`;
        return;
    }


    // 월별로 그룹화
    const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const monthGroups = {}; // key: 'YYYY-MM'
    const monthOrder = [];

    filteredNotes.forEach(note => {
        const dateObj = new Date(note.timestamp || Date.now());
        const key = `${dateObj.getFullYear()}-${String(dateObj.getMonth()+1).padStart(2,'0')}`;
        const label = `${dateObj.getFullYear()}년 ${dateObj.getMonth()+1}월`;
        if (!monthGroups[key]) {
            monthGroups[key] = { label, notes: [] };
            monthOrder.push(key);
        }
        monthGroups[key].notes.push(note);
    });

    // 최초 방문 시(null/undefined)에만 가장 최근 달 자동 펼침 (사용자가 직접 모든 월 카드를 접어서 빈 배열 []이 된 경우 재펼침 방지)
    if (state.expandedMonths === null || state.expandedMonths === undefined) {
        state.expandedMonths = monthOrder.length > 0 ? [monthOrder[0]] : [];
    }

    monthOrder.forEach(key => {
        const group = monthGroups[key];
        const isExpanded = Array.isArray(state.expandedMonths) && state.expandedMonths.includes(key);
        const count = group.notes.length;

        // 월 헤더 (클릭으로 접기/펼치기)
        const header = document.createElement('div');
        header.className = 'month-group-header' + (isExpanded ? ' expanded' : '');
        header.style.cursor = 'pointer';
        header.innerHTML = `
            <div class="month-group-left">
                <i class="far fa-calendar-check"></i>
                <span class="month-group-label">${group.label}</span>
                <span class="month-group-count">${count}건</span>
            </div>
            <i class="fas fa-chevron-${isExpanded ? 'up' : 'down'} month-chevron"></i>
        `;

        header.onclick = (e) => {
            if (e) e.stopPropagation();
            if (!Array.isArray(state.expandedMonths)) state.expandedMonths = [];
            const i = state.expandedMonths.indexOf(key);
            if (i > -1) {
                state.expandedMonths.splice(i, 1);
            } else {
                state.expandedMonths.push(key);
            }
            renderHomeNotes();
        };
        elements.homeNoteList.appendChild(header);

        // 노트 카드 (펼쳐진 경우만 렌더링)
        if (isExpanded) {
            const notesWrapper = document.createElement('div');
            notesWrapper.className = 'month-notes-wrapper';
            
            group.notes.forEach(note => {
                const dateObj = new Date(note.timestamp || Date.now());
                const day = dateObj.getDate();
                const monthStr = MONTH_ABBR[dateObj.getMonth()];

                const summaryData = note.summary || (note.content ? (() => {
                    const temp = document.createElement('div');
                    temp.innerHTML = note.content;
                    const b = temp.querySelector('.summary-block');
                    return b ? b.textContent : null;
                })() : null);

                const summaryTag = summaryData
                    ? `<span class="pane-worship-tag" style="background: var(--accent-primary)!important;color:white!important;cursor:pointer;" onclick="event.stopPropagation();window.showSummary('${note.id}')"><i class="fas fa-magic"></i> 요약</span>`
                    : '';

                const recordingTag = note.hasRecording
                    ? `<span class="pane-worship-tag" style="background: #e74c3c!important;color:white!important;cursor:pointer;margin-left:0.5rem;" onclick="event.stopPropagation(); document.getElementById('menu-record-list-btn').click();"><i class="fas fa-microphone"></i> 녹음</span>`
                    : '';

                const worshipTag = note.worshipType
                    ? `<span class="pane-worship-tag">${note.worshipType}</span>`
                    : '';

                const cardContainer = document.createElement('div');
                cardContainer.className = 'note-card-container';
                cardContainer.style.position = 'relative';
                cardContainer.style.overflow = 'hidden';
                cardContainer.style.marginBottom = '1rem';
                cardContainer.style.borderRadius = '16px';
                cardContainer.style.touchAction = 'pan-y';

                cardContainer.innerHTML = `
                    <div class="note-card-actions" style="position: absolute; inset: 0; display: flex; justify-content: space-between; align-items: center; padding: 0 1.5rem; background: #e2e8f0; border-radius: 16px;">
                        <div class="action-delete" style="color: #ef4444; font-weight: bold; font-size: 1rem; flex: 1; text-align: left; opacity: 0;"><i class="fas fa-trash"></i> 지우기</div>
                        <div class="action-share" style="color: #3b82f6; font-weight: bold; font-size: 1rem; flex: 1; text-align: right; opacity: 0;"><i class="fas fa-share-alt"></i> 공유</div>
                    </div>
                    <div class="note-card swipable" style="position: relative; z-index: 1; transition: transform 0.2s ease-out; margin: 0; width: 100%;">
                        <div class="note-card-date-badge">
                            <div class="note-card-date-day">${day}</div>
                            <div class="note-card-date-month">${monthStr}</div>
                        </div>
                        <div class="note-card-info">
                            <div class="note-card-tags">${worshipTag}${summaryTag}${recordingTag}</div>
                            <h4>${note.title || '제목 없는 설교'}</h4>
                            <p><i class="far fa-clock"></i> ${note.date || '날짜 없음'}</p>
                        </div>
                        <div class="note-card-chevron"><i class="fas fa-chevron-right"></i></div>
                    </div>
                `;

                const swipable = cardContainer.querySelector('.swipable');
                let startX = 0;
                let startY = 0;
                let currentX = 0;
                let isSwiping = false;
                let isHorizontalSwipe = null;

                swipable.addEventListener('pointerdown', e => {
                    startX = e.clientX;
                    startY = e.clientY;
                    isSwiping = true;
                    isHorizontalSwipe = null;
                    swipable.style.transition = 'none';
                    swipable.setPointerCapture(e.pointerId);
                });

                swipable.addEventListener('pointermove', e => {
                    if (!isSwiping) return;
                    
                    const deltaX = e.clientX - startX;
                    const deltaY = e.clientY - startY;

                    if (isHorizontalSwipe === null) {
                        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 5) {
                            isHorizontalSwipe = true;
                        } else if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 5) {
                            isHorizontalSwipe = false;
                            isSwiping = false;
                            return;
                        } else {
                            return; // Wait for more movement
                        }
                    }

                    if (isHorizontalSwipe) {
                        currentX = deltaX;
                        if (currentX > 100) currentX = 100;
                        if (currentX < -100) currentX = -100;
                        
                        const bg = cardContainer.querySelector('.note-card-actions');
                        const shareDiv = bg.querySelector('.action-share');
                        const delDiv = bg.querySelector('.action-delete');
                        
                        if (currentX > 0) {
                            bg.style.background = '#fef2f2';
                            shareDiv.style.opacity = '0';
                            delDiv.style.opacity = '1';
                        } else if (currentX < 0) {
                            bg.style.background = '#eff6ff';
                            shareDiv.style.opacity = '1';
                            delDiv.style.opacity = '0';
                        }
                        
                        swipable.style.transform = `translateX(${currentX}px)`;
                    }
                });

                const handlePointerEnd = (e) => {
                    if (!isSwiping) return;
                    isSwiping = false;
                    swipable.style.transition = 'transform 0.2s ease-out';
                    
                    if (currentX > 60) {
                        // Swipe Right -> Delete
                        swipable.style.transform = `translateX(100px)`;
                        setTimeout(() => {
                            if (confirm('지우시겠습니까? (예/아니오)')) {
                                deleteNoteById(note.id);
                            } else {
                                swipable.style.transform = 'translateX(0)';
                            }
                        }, 200);
                    } else if (currentX < -60) {
                        // Swipe Left -> Share
                        swipable.style.transform = `translateX(-100px)`;
                        setTimeout(() => {
                            if (confirm('공유하시겠습니까? (예/아니오)')) {
                                shareNoteById(note.id);
                            }
                            swipable.style.transform = 'translateX(0)';
                        }, 200);
                    } else {
                        swipable.style.transform = 'translateX(0)';
                    }
                    
                    setTimeout(() => currentX = 0, 50);
                };

                swipable.addEventListener('pointerup', handlePointerEnd);
                swipable.addEventListener('pointercancel', handlePointerEnd);

                swipable.onclick = (e) => {
                    if (Math.abs(currentX) > 10) {
                        e.preventDefault();
                        return;
                    }
                    loadNote(note.id);
                };
                
                notesWrapper.appendChild(cardContainer);
            });
            elements.homeNoteList.appendChild(notesWrapper);
        }
    });
}


function setActiveTab(type) {
    state.homeFilterType = type;
    localStorage.setItem('home_filter_type', type);
    renderHomeNotes();
}

/* ==========================================================================
   Side Drawer & Home View Switching
   ========================================================================== */
function openSideDrawer() {
    const drawer = document.getElementById('side-drawer');
    const overlay = document.getElementById('side-drawer-overlay');
    if (drawer) drawer.classList.add('open');
    if (overlay) overlay.classList.add('active');
    updateDrawerWorshipBtns();
}

function closeSideDrawer() {
    const drawer = document.getElementById('side-drawer');
    const overlay = document.getElementById('side-drawer-overlay');
    if (drawer) drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
}

function switchHomeView(mode, worshipType) {
    if (mode === 'all') {
        state.homeViewMode = 'all';
        state.homeFilterType = 'all';
    } else if (mode === 'worship') {
        state.homeViewMode = 'worship';
        state.homeFilterType = worshipType || 'all';
    }
    localStorage.setItem('home_view_mode', state.homeViewMode);
    localStorage.setItem('home_filter_type', state.homeFilterType);
    
    // 드로어 항목 active 표시 갱신
    updateDrawerWorshipBtns();
    
    // 왼쪽 상단 줄세개 눌러서 예배선택 및 모두보기 누르면 바로 설교 노트로 진입
    switchTab('sermon');
    
    closeSideDrawer();
}

function updateDrawerWorshipBtns() {
    // 드로어 전체보기 버튼
    const allBtn = document.getElementById('drawer-all-btn');
    if (allBtn) {
        allBtn.classList.toggle('active', state.homeViewMode === 'all');
    }
    
    const container = document.getElementById('drawer-worship-btns');
    if (!container) return;
    container.innerHTML = '';
    
    state.worshipTypes.forEach(type => {
        const count = Object.keys(state.notes).filter(id => (state.notes[id].worshipType || '주일예배') === type).length;
        const btn = document.createElement('button');
        btn.className = 'drawer-menu-item' + 
            (state.homeViewMode === 'worship' && state.homeFilterType === type ? ' active' : '');
        btn.innerHTML = `<i class="fas fa-church"></i><span>${type} <span style="opacity:0.6;font-size:0.75rem;">(${count})</span></span>`;
        btn.onclick = () => switchHomeView('worship', type);
        container.appendChild(btn);
    });
    
    // "예배별 전체" 버튼
    const allWorshipBtn = document.createElement('button');
    allWorshipBtn.className = 'drawer-menu-item' + 
        (state.homeViewMode === 'worship' && state.homeFilterType === 'all' ? ' active' : '');
    allWorshipBtn.innerHTML = `<i class="fas fa-list"></i><span>예배별 전체</span>`;
    allWorshipBtn.onclick = () => switchHomeView('worship', 'all');
    container.insertBefore(allWorshipBtn, container.firstChild);
}


// Calendar Logic
function renderCalendar() {
    const year = state.currentDate.getFullYear();
    const month = state.currentDate.getMonth();
    elements.calendarMonthYear.textContent = `${year}년 ${month + 1}월`;

    const firstDay = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();
    
    elements.calendarDays.innerHTML = '';

    // Empty spaces
    for (let i = 0; i < firstDay; i++) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'calendar-day empty';
        elements.calendarDays.appendChild(emptyEl);
    }

    const todayStr = new Date().toISOString().split('T')[0];
    
    // Group notes by ISO Date
    const notesByDate = {};
    Object.keys(state.notes).forEach(id => {
        const note = state.notes[id];
        const date = note.isoDate;
        if (!date) return;
        if (!notesByDate[date]) notesByDate[date] = [];
        notesByDate[date].push({ id, ...note });
    });

    for (let d = 1; d <= lastDate; d++) {
        const dayEl = document.createElement('div');
        dayEl.className = 'calendar-day';
        dayEl.textContent = d;
        
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayOfWeek = new Date(year, month, d).getDay();
        
        if (dayOfWeek === 0) dayEl.classList.add('sunday');
        if (dayOfWeek === 6) dayEl.classList.add('saturday');
        if (dateStr === todayStr) dayEl.classList.add('today');
        
        const dayNotes = notesByDate[dateStr];
        if (dayNotes && dayNotes.length > 0) {
            dayEl.classList.add('has-note');
            dayEl.onclick = () => {
                // Remove selected from others
                document.querySelectorAll('.calendar-day.selected').forEach(el => el.classList.remove('selected'));
                dayEl.classList.add('selected');
                openCalendarNotesPane(dateStr, dayNotes);
            };
        } else {
            dayEl.onclick = () => {
                document.querySelectorAll('.calendar-day.selected').forEach(el => el.classList.remove('selected'));
                dayEl.classList.add('selected');
            };
        }
        
        elements.calendarDays.appendChild(dayEl);
    }
}


// Auto Save
function autoSave() {
    if (!state.currentNoteId || !state.notes[state.currentNoteId]) return;
    
    const note = state.notes[state.currentNoteId];
    if (!note.pages || !Array.isArray(note.pages)) {
        note.pages = [ { content: note.content || '', drawingData: note.drawingData || null } ];
    }
    
    saveAllPages(true);
    note.title = elements.titleInput.value;
    
    if (elements.noteWorshipType) {
        note.worshipType = elements.noteWorshipType.value;
    }
    
    if (elements.noteDate && elements.noteDate.value) {
        note.isoDate = elements.noteDate.value;
        const d = new Date(elements.noteDate.value);
        note.date = d.toLocaleDateString('ko-KR');
    }
    
    note.timestamp = Date.now(); // Update TS
    saveToStorage(); // 로컬 저장은 즉시 (데이터 안전)
    debouncedSyncToFirestore(); // ✅ Firestore는 30초 debounce로 묶어서 저장 (비용 절감)
}

function saveToStorage() {
    const keys = getUserStorageKeys();
    localStorage.setItem(keys.notes, JSON.stringify(state.notes));
    localStorage.setItem(keys.deletedNotes, JSON.stringify(state.deletedNotes));
    isStateDirty = true; // 로컬 데이터가 변경되었음을 표시
}

function saveWorshipTypesToStorage() {
    const keys = getUserStorageKeys();
    localStorage.setItem(keys.worshipTypes, JSON.stringify(state.worshipTypes));
    localStorage.setItem(keys.expandedWorshipTypes, JSON.stringify(state.expandedWorshipTypes));
    isStateDirty = true;
}

/* ==========================================================================
   Worship Type Accordion and Modal Control Helpers
   ========================================================================== */
function renderWorshipTypes() {
    if (!elements.worshipTypeList) return;
    elements.worshipTypeList.innerHTML = '';
    
    // 1. Render custom projects in state.worshipTypes
    state.worshipTypes.forEach(type => {
        // Find notes belonging to this type
        const filteredNotes = Object.keys(state.notes)
            .filter(id => (state.notes[id].worshipType || '주일예배') === type)
            .map(id => ({ id, ...state.notes[id] }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            
        const card = document.createElement('div');
        const isExpanded = state.expandedWorshipTypes.includes(type);
        card.className = `worship-card ${isExpanded ? 'expanded' : ''}`;
        
        let sermonsHTML = '';
        if (filteredNotes.length === 0) {
            sermonsHTML = '<div class="worship-sermon-item empty-worship"><span class="worship-sermon-title" style="color: var(--text-muted); font-size: 0.8rem; font-style: italic;">이 분류에 기록된 설교가 없습니다.</span></div>';
        } else {
            filteredNotes.forEach(note => {
                let tagsHTML = '';
                const summaryData = note.summary || (note.content ? (() => { const temp = document.createElement('div'); temp.innerHTML = note.content; const b = temp.querySelector('.summary-block'); return b ? b.textContent : null; })() : null);
                if (summaryData) {
                    tagsHTML += `<span class="pane-worship-tag" style="display: inline-block; background: var(--accent-primary) !important; color: white !important; cursor: pointer; margin-left: 0.5rem;" onclick="event.stopPropagation(); window.showSummary('${note.id}')"><i class="fas fa-magic"></i> 요약</span>`;
                }
                if (note.hasRecording) {
                    tagsHTML += `<span class="pane-worship-tag" style="display: inline-block; background: #e74c3c !important; color: white !important; cursor: pointer; margin-left: 0.5rem;" onclick="event.stopPropagation(); document.getElementById('menu-record-list-btn').click();"><i class="fas fa-microphone"></i> 녹음</span>`;
                }
                
                sermonsHTML += `
                    <div class="worship-sermon-item" data-note-id="${note.id}" style="display: flex; flex-wrap: wrap; align-items: center;">
                        <span class="worship-sermon-title" style="flex: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">${note.title || '제목 없는 설교'}</span>
                        ${tagsHTML}
                        <span class="worship-sermon-date" style="flex-shrink: 0; margin-left: 0.5rem;">${note.date}</span>
                    </div>
                `;
            });
        }
        
        card.innerHTML = `
            <div class="worship-card-header">
                <div class="worship-card-info">
                    <div class="worship-card-icon">
                        <i class="fas fa-church"></i>
                    </div>
                    <span class="worship-card-name">${type}</span>
                    <button class="icon-btn edit-worship-btn" title="이름 수정" style="background: none; padding: 4px; min-width: auto; height: auto; margin-left: 0.5rem; color: var(--text-muted); opacity: 0.6; border: none; outline: none; cursor: pointer;">
                        <i class="fas fa-pen" style="font-size: 0.75rem;"></i>
                    </button>
                    <button class="icon-btn delete-worship-btn" title="삭제" style="background: none; padding: 4px; min-width: auto; height: auto; margin-left: 0.25rem; color: var(--text-muted); opacity: 0.6; border: none; outline: none; cursor: pointer;">
                        <i class="fas fa-trash-alt" style="font-size: 0.75rem;"></i>
                    </button>
                    <span class="worship-card-count">${filteredNotes.length}</span>
                </div>
                <i class="fas fa-chevron-down worship-card-toggle"></i>
            </div>
            <div class="worship-sermons-list" style="${isExpanded ? 'max-height: 500px;' : ''}">
                ${sermonsHTML}
            </div>
        `;
        
        // Setup toggle click on header
        const header = card.querySelector('.worship-card-header');
        header.onclick = (e) => {
            e.stopPropagation();
            toggleWorshipTypeExpansion(type);
        };
        
        // Setup edit button click
        const editBtn = card.querySelector('.edit-worship-btn');
        if (editBtn) {
            editBtn.onclick = (e) => {
                e.stopPropagation(); // Prevent accordion toggle
                renameWorshipType(type);
            };
        }

        // Setup delete button click
        const deleteBtn = card.querySelector('.delete-worship-btn');
        if (deleteBtn) {
            deleteBtn.onclick = (e) => {
                e.stopPropagation(); // Prevent accordion toggle
                deleteWorshipType(type);
            };
        }
        
        // Setup sermon item clicks
        card.querySelectorAll('.worship-sermon-item').forEach(item => {
            const noteId = item.dataset.noteId;
            if (noteId) {
                item.onclick = (e) => {
                    e.stopPropagation();
                    loadNote(noteId);
                };
            }
        });
        
        elements.worshipTypeList.appendChild(card);
    });

    // 2. Render Virtual Fallback Folder '프로젝트 없음'
    // Gather notes belonging to '프로젝트 없음' or whose worshipType is no longer in custom list
    const fallbackNotes = Object.keys(state.notes)
        .filter(id => {
            const t = state.notes[id].worshipType;
            return !t || t === '프로젝트 없음' || !state.worshipTypes.includes(t);
        })
        .map(id => ({ id, ...state.notes[id] }))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Render whenever there are fallback notes, or if the main folder list is completely empty
    if (fallbackNotes.length > 0 || state.worshipTypes.length === 0) {
        const type = '프로젝트 없음';
        const card = document.createElement('div');
        const isExpanded = state.expandedWorshipTypes.includes(type);
        card.className = `worship-card fallback-card ${isExpanded ? 'expanded' : ''}`;
        
        let sermonsHTML = '';
        if (fallbackNotes.length === 0) {
            sermonsHTML = '<div class="worship-sermon-item empty-worship"><span class="worship-sermon-title" style="color: var(--text-muted); font-size: 0.8rem; font-style: italic;">이 분류에 기록된 설교가 없습니다.</span></div>';
        } else {
            fallbackNotes.forEach(note => {
                let tagsHTML = '';
                const summaryData = note.summary || (note.content ? (() => { const temp = document.createElement('div'); temp.innerHTML = note.content; const b = temp.querySelector('.summary-block'); return b ? b.textContent : null; })() : null);
                if (summaryData) {
                    tagsHTML += `<span class="pane-worship-tag" style="display: inline-block; background: var(--accent-primary) !important; color: white !important; cursor: pointer; margin-left: 0.5rem;" onclick="event.stopPropagation(); window.showSummary('${note.id}')"><i class="fas fa-magic"></i> 요약</span>`;
                }
                if (note.hasRecording) {
                    tagsHTML += `<span class="pane-worship-tag" style="display: inline-block; background: #e74c3c !important; color: white !important; cursor: pointer; margin-left: 0.5rem;" onclick="event.stopPropagation(); document.getElementById('menu-record-list-btn').click();"><i class="fas fa-microphone"></i> 녹음</span>`;
                }
                
                sermonsHTML += `
                    <div class="worship-sermon-item" data-note-id="${note.id}" style="display: flex; flex-wrap: wrap; align-items: center;">
                        <span class="worship-sermon-title" style="flex: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">${note.title || '제목 없는 설교'}</span>
                        ${tagsHTML}
                        <span class="worship-sermon-date" style="flex-shrink: 0; margin-left: 0.5rem;">${note.date}</span>
                    </div>
                `;
            });
        }
        
        card.innerHTML = `
            <div class="worship-card-header" style="background: rgba(100, 116, 139, 0.03);">
                <div class="worship-card-info">
                    <div class="worship-card-icon" style="background: rgba(100, 116, 139, 0.08); color: var(--text-muted);">
                        <i class="fas fa-folder"></i>
                    </div>
                    <span class="worship-card-name" style="color: var(--text-muted); font-style: italic;">${type}</span>
                    <span class="worship-card-count" style="background: rgba(100, 116, 139, 0.12);">${fallbackNotes.length}</span>
                </div>
                <i class="fas fa-chevron-down worship-card-toggle" style="color: var(--text-muted);"></i>
            </div>
            <div class="worship-sermons-list" style="${isExpanded ? 'max-height: 500px;' : ''}">
                ${sermonsHTML}
            </div>
        `;
        
        const header = card.querySelector('.worship-card-header');
        header.onclick = (e) => {
            e.stopPropagation();
            toggleWorshipTypeExpansion(type);
        };
        
        card.querySelectorAll('.worship-sermon-item').forEach(item => {
            const noteId = item.dataset.noteId;
            if (noteId) {
                item.onclick = (e) => {
                    e.stopPropagation();
                    loadNote(noteId);
                };
            }
        });
        
        elements.worshipTypeList.appendChild(card);
    }
}

function renameWorshipType(oldName) {
    const newName = prompt(`'${oldName}' 예배 구분의 이름을 무엇으로 수정하시겠습니까?`, oldName);
    if (newName === null) return; // Cancelled
    const trimmed = newName.trim();
    if (!trimmed) {
        showToast('올바른 이름을 입력해 주세요.');
        return;
    }
    if (trimmed === oldName) return; // No change
    
    if (state.worshipTypes.includes(trimmed)) {
        showToast('이미 존재하는 이름입니다.');
        return;
    }
    
    // 1. Rename in state.worshipTypes list
    const idx = state.worshipTypes.indexOf(oldName);
    if (idx > -1) {
        state.worshipTypes[idx] = trimmed;
    }
    
    // 2. Rename in state.expandedWorshipTypes list
    const expIdx = state.expandedWorshipTypes.indexOf(oldName);
    if (expIdx > -1) {
        state.expandedWorshipTypes[expIdx] = trimmed;
    }
    
    // 3. Rename worshipType field in all matching sermon notes
    Object.keys(state.notes).forEach(id => {
        if ((state.notes[id].worshipType || '주일예배') === oldName) {
            state.notes[id].worshipType = trimmed;
        }
    });
    
    // 4. Save to localStorage & Firebase
    saveToStorage();
    saveWorshipTypesToStorage();
    syncToFirestore();
    
    // 5. Refresh view
    renderHomeNotes();
    renderWorshipTypes();
    showToast('예배 이름이 수정되었습니다.');
}

function deleteWorshipType(name) {
    if (confirm(`'${name}' 예배 구분을 삭제하시겠습니까?\n소속된 모든 설교 기록은 '프로젝트 없음' 폴더로 안전하게 이동됩니다.`)) {
        // 1. Remove from custom folder list
        const idx = state.worshipTypes.indexOf(name);
        if (idx > -1) {
            state.worshipTypes.splice(idx, 1);
        }
        
        // 2. Remove from expanded folders tracker
        const expIdx = state.expandedWorshipTypes.indexOf(name);
        if (expIdx > -1) {
            state.expandedWorshipTypes.splice(expIdx, 1);
        }
        
        // 3. Reset worshipType in all notes previously under this folder to '프로젝트 없음'
        Object.keys(state.notes).forEach(id => {
            if (state.notes[id].worshipType === name) {
                state.notes[id].worshipType = '프로젝트 없음';
            }
        });
        
        // 4. Save storage states & cloud sync
        saveToStorage();
        saveWorshipTypesToStorage();
        syncToFirestore();
        
        // 5. Refresh
        renderHomeNotes();
        renderWorshipTypes();
        showToast(`'${name}' 예배 구분이 삭제되었습니다.`);
    }
}

function toggleWorshipTypeExpansion(type) {
    if (!state.expandedWorshipTypes) state.expandedWorshipTypes = [];
    const idx = state.expandedWorshipTypes.indexOf(type);
    if (idx > -1) {
        state.expandedWorshipTypes.splice(idx, 1);
    } else {
        state.expandedWorshipTypes.push(type);
    }
    const keys = getUserStorageKeys();
    localStorage.setItem(keys.expandedWorshipTypes, JSON.stringify(state.expandedWorshipTypes));
    renderWorshipTypes();
}

function populateWorshipTypeSelect(currentVal) {
    if (!elements.noteWorshipType) return;
    elements.noteWorshipType.innerHTML = '';
    
    // Add default safety option '프로젝트 없음' at the very top of dropdown select list
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '프로젝트 없음';
    defaultOpt.textContent = '프로젝트 없음';
    if (currentVal === '프로젝트 없음' || !currentVal) {
        defaultOpt.selected = true;
    }
    elements.noteWorshipType.appendChild(defaultOpt);
    
    state.worshipTypes.forEach(type => {
        const opt = document.createElement('option');
        opt.value = type;
        opt.textContent = type;
        if (type === currentVal) {
            opt.selected = true;
        }
        elements.noteWorshipType.appendChild(opt);
    });
}

function openWorshipModal() {
    const modal = document.getElementById('worship-modal');
    const input = document.getElementById('new-worship-name');
    if (modal) {
        modal.classList.add('active');
        if (input) {
            input.value = '';
            input.focus();
        }
    }
}

function closeWorshipModal() {
    const modal = document.getElementById('worship-modal');
    if (modal) modal.classList.remove('active');
}

function saveNewWorshipType() {
    const input = document.getElementById('new-worship-name');
    if (!input) return;
    const name = input.value.trim();
    if (!name) {
        showToast('예배 구분 이름을 입력해 주세요.');
        return;
    }
    
    if (state.worshipTypes.includes(name)) {
        showToast('이미 존재하는 예배 구분입니다.');
        return;
    }
    
    state.worshipTypes.push(name);
    const keys = getUserStorageKeys();
    localStorage.setItem(keys.worshipTypes, JSON.stringify(state.worshipTypes));
    
    // Sync to Firestore
    syncToFirestore();
    
    // Refresh
    renderWorshipTypes();
    closeWorshipModal();
    showToast(`'${name}'이(가) 추가되었습니다.`);
}

/* ==========================================================================
   Calendar Slide-Over Pane Helpers
   ========================================================================== */
function openCalendarNotesPane(dateStr, notes) {
    if (!elements.calendarNotesPane || !elements.calendarPaneDate || !elements.calendarPaneList) return;
    
    const parts = dateStr.split('-');
    elements.calendarPaneDate.textContent = `${parts[0]}년 ${parseInt(parts[1])}월 ${parseInt(parts[2])}일`;
    
    elements.calendarPaneList.innerHTML = '';
    notes.forEach(note => {
        const card = document.createElement('div');
        card.className = 'pane-note-card';
        
        const wTag = note.worshipType ? `<span class="pane-worship-tag">${note.worshipType}</span>` : '';
        
        card.innerHTML = `
            <div class="pane-note-info">
                <h5>${note.title || '제목 없는 설교'}</h5>
                <p>${wTag}<i class="far fa-clock"></i> ${note.date}</p>
            </div>
            <i class="fas fa-chevron-right" style="color: var(--text-muted); font-size: 0.85rem;"></i>
        `;
        
        card.onclick = () => {
            closeCalendarNotesPane();
            elements.calendarView.classList.remove('active');
            loadNote(note.id);
        };
        
        elements.calendarPaneList.appendChild(card);
    });
    
    elements.calendarNotesPane.classList.add('active');
}

function closeCalendarNotesPane() {
    if (elements.calendarNotesPane) {
        elements.calendarNotesPane.classList.remove('active');
    }
}


// Bible Logic (Simplified for brevity, same core logic)
const BIBLE_BOOKS = { '창': { name: '창세기', id: 1 }, '출': { name: '출애굽기', id: 2 }, '레': { name: '레위기', id: 3 }, '민': { name: '민수기', id: 4 }, '신': { name: '신명기', id: 5 }, '수': { name: '여호수아', id: 6 }, '삿': { name: '사사기', id: 7 }, '룻': { name: '룻기', id: 8 }, '삼상': { name: '사무엘상', id: 9 }, '삼하': { name: '사무엘하', id: 10 }, '왕상': { name: '열왕기상', id: 11 }, '왕하': { name: '열왕기하', id: 12 }, '대상': { name: '역대상', id: 13 }, '대하': { name: '역대하', id: 14 }, '스': { name: '에스라', id: 15 }, '느': { name: '느헤미야', id: 16 }, '에': { name: '에스더', id: 17 }, '욥': { name: '욥기', id: 18 }, '시': { name: '시편', id: 19 }, '잠': { name: '잠언', id: 20 }, '전': { name: '전도서', id: 21 }, '아': { name: '아가', id: 22 }, '사': { name: '이사야', id: 23 }, '렘': { name: '예레미야', id: 24 }, '애': { name: '예레미야애가', id: 25 }, '겔': { name: '에스겔', id: 26 }, '단': { name: '다니엘', id: 27 }, '호': { name: '호세아', id: 28 }, '욜': { name: '요엘', id: 29 }, '암': { name: '아모스', id: 30 }, '오': { name: '오바댜', id: 31 }, '요나': { name: '요나', id: 32 }, '미': { name: '미가', id: 33 }, '나': { name: '나훔', id: 34 }, '합': { name: '하박국', id: 35 }, '습': { name: '스바냐', id: 36 }, '학': { name: '학개', id: 37 }, '슥': { name: '스가랴', id: 38 }, '말': { name: '말라기', id: 39 }, '마': { name: '마태복음', id: 40 }, '막': { name: '마가복음', id: 41 }, '눅': { name: '누가복음', id: 42 }, '요': { name: '요한복음', id: 43 }, '행': { name: '사도행전', id: 44 }, '롬': { name: '로마서', id: 45 }, '고전': { name: '고린도전서', id: 46 }, '고후': { name: '고린도후서', id: 47 }, '갈': { name: '갈라디아서', id: 48 }, '엡': { name: '에베소서', id: 49 }, '빌': { name: '빌립보서', id: 50 }, '골': { name: '골로새서', id: 51 }, '살전': { name: '데살로니가전서', id: 52 }, '살후': { name: '데살로니가후서', id: 53 }, '딤전': { name: '디모데전서', id: 54 }, '딤후': { name: '디모데후서', id: 55 }, '딛': { name: '디도서', id: 56 }, '몬': { name: '빌레몬', id: 57 }, '히': { name: '히브리서', id: 58 }, '약': { name: '야고보서', id: 59 }, '야': { name: '야고보서', id: 59 }, '벧전': { name: '베드로전서', id: 60 }, '벧후': { name: '베드로후서', id: 61 }, '요1': { name: '요한1서', id: 62 }, '요일': { name: '요한일서', id: 62 }, '요2': { name: '요한2서', id: 63 }, '요이': { name: '요한이서', id: 63 }, '요3': { name: '요한3서', id: 64 }, '요삼': { name: '요한삼서', id: 64 }, '유': { name: '유다서', id: 65 }, '계': { name: '요한계시록', id: 66 } };

function jumpToBibleReferenceInEditor(displayRef) {
    const parseRegex = /^([가-힣\d]+)\s+(\d+):(\d+)(?:-(\d+))?$/;
    const match = displayRef.match(parseRegex);
    if (!match) return;

    const fullName = match[1];
    const chapter = match[2];
    const verseStart = match[3];

    // Find abbreviation
    const abbr = Object.keys(BIBLE_BOOKS).find(key => BIBLE_BOOKS[key].name === fullName) || fullName;

    // Search regex for shorthand or full name followed by chapter and verse
    const searchRegex = new RegExp(`(${abbr}|${fullName})\\s*${chapter}(?:\\s*[:：장]\\s*|\\s+)${verseStart}`, 'i');

    const editors = document.querySelectorAll('.sermon-editor');
    for (let editor of editors) {
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
            const text = node.textContent;
            const searchMatch = text.match(searchRegex);
            if (searchMatch) {
                const index = searchMatch.index;

                // Sync page wrapper
                const pageEl = editor.closest('.a4-page-wrapper');
                if (pageEl) {
                    const pageIndex = parseInt(pageEl.dataset.index);
                    state.currentPageIndex = pageIndex;
                    updatePageNavigator();
                    pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }

                editor.focus();

                const range = document.createRange();
                const sel = window.getSelection();
                const cursorPosition = index + searchMatch[0].length;
                try {
                    range.setStart(node, cursorPosition);
                    range.setEnd(node, cursorPosition);
                    sel.removeAllRanges();
                    sel.addRange(range);
                } catch(e) {
                    console.error("Failed to set selection range", e);
                }
                return;
            }
        }
    }
}

async function detectBibleReferences(text) {
    const editors = document.querySelectorAll('.sermon-editor');
    let combinedText = '';
    if (editors && editors.length > 0) {
        editors.forEach(editor => {
            combinedText += editor.innerText + '\n';
        });
    } else {
        combinedText = text || '';
    }

    const bibleRegex = /([1-3]?[ㄱ-ㅎ가-힣]{1,5}[1-3]?)\s*(\d+)(?:\s*[:：장]\s*|\s+)(\d+)(?:\s*[-~절]\s*(\d+)?(?:절)?)?/g;
    let match;
    const foundReferences = [];
    
    while ((match = bibleRegex.exec(combinedText)) !== null) {
        const bookRaw = match[1];
        const chapter = match[2];
        const verseStart = match[3];
        const verseEnd = match[4] || verseStart;
        
        let bookInfo = BIBLE_BOOKS[bookRaw];
        if (!bookInfo) {
            bookInfo = Object.values(BIBLE_BOOKS).find(b => b.name === bookRaw);
        }
        
        if (!bookInfo) continue;
        
        const displayReference = `${bookInfo.name} ${chapter}:${verseStart}${match[4] ? '-' + match[4] : ''}`;
        const rawReference = `${bookRaw} ${chapter}:${verseStart}${match[4] ? '-' + match[4] : ''}`;
        
        foundReferences.push({
            reference: displayReference,
            rawReference,
            bookId: bookInfo.id,
            chapter,
            verseStart,
            verseEnd,
            index: match.index
        });
    }

    foundReferences.sort((a, b) => a.index - b.index);
    state.versePositions = foundReferences.map(r => ({
        ref: r.reference,
        index: r.index,
        cardId: `verse-${r.reference.replace(/\s|:|~|-/g, '-')}`
    }));

    const currentRefs = new Set(foundReferences.map(r => r.reference));
    state.detectedVerses.forEach(ref => {
        if (!currentRefs.has(ref)) {
            const cardId = `verse-${ref.replace(/\s|:|~|-/g, '-')}`;
            const card = document.getElementById(cardId);
            if (card) card.remove();
            state.detectedVerses.delete(ref);
        }
    });

    foundReferences.forEach((refData, idx) => {
        if (!state.detectedVerses.has(refData.reference)) {
            state.detectedVerses.add(refData.reference);
            fetchVerse(refData.bookId, refData.chapter, refData.verseStart, refData.verseEnd, refData.reference, idx);
        } else {
            const cardId = `verse-${refData.reference.replace(/\s|:|~|-/g, '-')}`;
            const card = document.getElementById(cardId);
            if (card && elements.verseGallery) {
                elements.verseGallery.appendChild(card);
            }
        }
    });

    if (elements.verseCount) elements.verseCount.textContent = state.detectedVerses.size;
    const biblePane = document.getElementById('bible-view');
    if (biblePane) {
        biblePane.classList.toggle('has-verses', state.detectedVerses.size > 0);
    }

    if (foundReferences.length > 0 && elements.verseGallery) {
        const lastRef = foundReferences[foundReferences.length - 1];
        const lastCardId = `verse-${lastRef.reference.replace(/\s|:|~|-/g, '-')}`;
        setTimeout(() => {
            const lastCard = document.getElementById(lastCardId);
            if (lastCard && elements.verseGallery) {
                document.querySelectorAll('.verse-card').forEach(c => c.classList.remove('active-sync'));
                lastCard.classList.add('active-sync');
                lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 300);
    }
}

async function fetchVerse(bookId, chapter, start, end, displayRef, order) {
    const cardId = `verse-${displayRef.replace(/\s|:|~|-/g, '-')}`;
    if (document.getElementById(cardId)) return;

    const card = document.createElement('div');
    card.id = cardId;
    card.className = 'verse-card';
    card.innerHTML = `
        <div class="verse-header">
            <span class="verse-ref">${displayRef}</span>
            <div class="verse-actions">
                <button class="verse-btn insert-btn" title="본문 삽입">
                    <i class="fas fa-file-import"></i> 입력
                </button>
            </div>
        </div>
        <div class="verse-text loading">불러오는 중...</div>
    `;

    if (elements.verseGallery) {
        if (elements.verseGallery.querySelector('.empty-state')) elements.verseGallery.innerHTML = '';
        elements.verseGallery.appendChild(card);
    }

    try {
        let fullText = '';
        let plainText = '';
        let versionLabel = '';

        if (state.bibleVersion === 'NKRV') {
            if (!NKRV_DATA) {
                card.querySelector('.verse-text').textContent = '데이터 로딩 중...';
                return;
            }
            const bookIdx = bookId - 1;
            const chapIdx = parseInt(chapter) - 1;
            const vStart = parseInt(start);
            const vEnd = parseInt(end);
            
            const bookData = NKRV_DATA[bookIdx];
            if (bookData && bookData.chapters[chapIdx]) {
                const chapterData = bookData.chapters[chapIdx];
                for (let v = vStart; v <= vEnd; v++) {
                    const text = chapterData[v - 1];
                    if (text) {
                        const cleanText = text.replace(/<[^>]+>/g, '').trim();
                        fullText += `<div class="verse-line"><span class="v-num">${v}</span> ${cleanText}</div>`;
                        plainText += `[${v}] ${cleanText}\n`;
                    }
                }
                versionLabel = '개역개정';
            }
        } else if (state.bibleVersion === 'KKJV') {
            if (!KKJV_DATA) {
                card.querySelector('.verse-text').textContent = '데이터 로딩 중...';
                return;
            }
            // KKJV structure: { books: [ { name, chapters: [ { chapter, verses: [ { verse, text } ] } ] } ] }
            const bookIdx = bookId - 1;
            const chapIdx = parseInt(chapter) - 1;
            const vStart = parseInt(start);
            const vEnd = parseInt(end);
            
            const bookData = KKJV_DATA.books[bookIdx];
            if (bookData && bookData.chapters[chapIdx]) {
                const chapterData = bookData.chapters[chapIdx];
                const versesInRange = chapterData.verses.filter(v => v.verse >= vStart && v.verse <= vEnd);
                
                versesInRange.forEach(v => {
                    fullText += `<div class="verse-line"><span class="v-num">${v.verse}</span> ${v.text}</div>`;
                    plainText += `[${v.verse}] ${v.text}\n`;
                });
                versionLabel = '흠정역';
            }
        } else {
            const response = await fetch(`${CONFIG.BIBLE_API}/get-text/${state.bibleVersion}/${bookId}/${chapter}/`);
            const data = await response.json();
            if (data && data.length > 0) {
                const vStart = parseInt(start);
                const vEnd = parseInt(end);
                const filtered = data.filter(v => v.verse >= vStart && v.verse <= vEnd);
                fullText = filtered.map(v => `<div class="verse-line"><span class="v-num">${v.verse}</span> ${v.text}</div>`).join('');
                plainText = filtered.map(v => `[${v.verse}] ${v.text}`).join('\n');
                versionLabel = state.bibleVersion === 'KRV' ? '개역한글' : (state.bibleVersion === 'KJV' ? 'KJV' : '새번역');
            }
        }

        if (fullText) {
            const verseTextEl = card.querySelector('.verse-text');
            verseTextEl.innerHTML = fullText;
            verseTextEl.classList.remove('loading');
            verseTextEl.style.fontSize = state.bibleFontSize + 'px';
            verseTextEl.style.fontFamily = "'Nanum Myeongjo', '나눔명조', serif";
            card.dataset.plainText = plainText;
            
            // Add version tag
            const refSpan = card.querySelector('.verse-ref');
            refSpan.innerHTML = `<span class="version-tag">${versionLabel}</span>${displayRef}`;
            
            // Add Click Handler for individual Insert
            card.querySelector('.insert-btn').onclick = () => {
                insertTextToEditor(`\n[${displayRef} ${versionLabel}]\n${plainText}\n`);
            };
        } else {
            card.querySelector('.verse-text').textContent = '검색 결과 없음';
        }
    } catch (e) { 
        console.error(e);
        card.querySelector('.verse-text').textContent = '로드 실패'; 
    }
    syncBibleScroll();
}

function insertAllVersesToEditor() {
    const cards = document.querySelectorAll('.verse-card');
    if (cards.length === 0) {
        showToast('삽입할 구절이 없습니다.');
        return;
    }

    let allText = "\n";
    cards.forEach(card => {
        const ref = card.querySelector('.verse-ref').textContent;
        const text = card.dataset.plainText || "";
        allText += `\n[${ref}]\n${text}\n`;
    });

    insertTextToEditor(allText);
}

function insertTextToEditor(text) {
    if (!document.querySelector('.sermon-editor')) return;
    
    document.querySelector('.sermon-editor').focus();
    // Convert newlines to <br> or wrap in divs for contenteditable
    const htmlText = text.replace(/\n/g, '<br>');
    document.execCommand('insertHTML', false, htmlText);
    
    autoSave();
    showToast('본문이 삽입되었습니다.');
}

function toggleAllVerses() {
    state.allVersesHidden = !state.allVersesHidden;
    document.querySelectorAll('.verse-text').forEach(el => el.classList.toggle('blurred', state.allVersesHidden));
    showToast(state.allVersesHidden ? '숨김' : '표시');
}

function syncBibleScroll() {
    if (!document.querySelector('.sermon-editor') || !elements.verseGallery || state.versePositions.length === 0) return;
    // 수동 모드(!autoInsert)에서만 동작
    if (state.autoInsert) return;

    // 타이핑 중(is-typing)에는 성경 구절 스크롤이 튀는 것을 방지하기 위해 중단
    const viewContainer = document.querySelector('.view-container');
    if (viewContainer && viewContainer.classList.contains('is-typing')) {
        return;
    }

    // 복수 에디터 대응 글로벌 캐럿 인덱스 구하기
    const cursorPos = getGlobalCursorPos();
    
    let activeVerse = null;
    let minDiff = Infinity;
    
    for (const v of state.versePositions) {
        const diff = Math.abs(v.index - cursorPos);
        if (diff < minDiff) {
            minDiff = diff;
            activeVerse = v;
        }
    }

    if (activeVerse) {
        const card = document.getElementById(activeVerse.cardId);
        if (card) {
            document.querySelectorAll('.verse-card').forEach(c => c.classList.remove('active-sync'));
            card.classList.add('active-sync');

            const container = elements.verseGallery;
            const containerRect = container.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            
            const relativeTop = cardRect.top - containerRect.top + container.scrollTop;
            const targetTop = relativeTop - 20;

            // Only scroll if significantly different to avoid jitter
            if (Math.abs(container.scrollTop - targetTop) > 10) {
                container.scrollTo({
                    top: targetTop,
                    behavior: 'smooth'
                });
            }
        }
    }
}

let toastTimeout;
function showToast(msg, type = 'info', duration = 4000) {
    if (!elements.toast) return;
    elements.toast.textContent = msg;
    
    // Set colors based on type
    if (type === 'error') {
        elements.toast.style.background = '#e74c3c';
        elements.toast.style.color = 'white';
        duration = 6000;
    } else if (type === 'warning') {
        elements.toast.style.background = '#f39c12';
        elements.toast.style.color = 'white';
    } else {
        elements.toast.style.background = 'var(--text-main)';
        elements.toast.style.color = 'var(--bg-dark)';
    }

    elements.toast.classList.add('show');
    
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => elements.toast.classList.remove('show'), duration);
}

function toggleAutoInsert() {
    state.autoInsert = !state.autoInsert;
    localStorage.setItem('app_auto_insert', state.autoInsert);
    applyAutoInsertUI();
    syncToFirestore();
    showToast(state.autoInsert ? '자동 입력 모드 켜짐' : '자동 입력 모드 꺼짐');
}

function applyAutoInsertUI() {
    const container = document.getElementById('auto-insert-toggle');
    if (container) {
        const manualBtn = container.querySelector('[data-mode="manual"]');
        const autoBtn = container.querySelector('[data-mode="auto"]');
        if (manualBtn) manualBtn.classList.toggle('active', !state.autoInsert);
        if (autoBtn) autoBtn.classList.toggle('active', state.autoInsert);
    }
    const pane = document.querySelector('.reference-pane');
    if (pane) pane.style.display = state.autoInsert ? 'none' : 'flex';
    
    if (elements.editorView) {
        elements.editorView.classList.toggle('manual-mode', !state.autoInsert);
    }
}

async function processVerseInsertion(rawMatch, bookRaw, chapter, verseStart, verseEnd, range) {
    // Look up by shorthand OR full name
    let bookInfo = BIBLE_BOOKS[bookRaw];
    if (!bookInfo) {
        bookInfo = Object.values(BIBLE_BOOKS).find(b => b.name === bookRaw);
    }
    
    if (!bookInfo) return;

    try {
        let fullVerseText = '';
        const vStart = parseInt(verseStart);
        const vEnd = parseInt(verseEnd);
        const displayRef = `${bookInfo.name} ${chapter}:${verseStart}${verseEnd !== verseStart ? '-' + verseEnd : ''}`;

        if (state.bibleVersion === 'NKRV' && NKRV_DATA) {
            const bookData = NKRV_DATA[bookInfo.id - 1];
            if (bookData && bookData.chapters[chapter - 1]) {
                const chapterData = bookData.chapters[chapter - 1];
                for (let v = vStart; v <= vEnd; v++) {
                    const text = chapterData[v - 1];
                    if (text) {
                        const cleanText = text.replace(/<[^>]+>/g, '').trim();
                        if (vStart === vEnd) {
                            fullVerseText += ` ${cleanText}`;
                        } else {
                            fullVerseText += ` [${v}] ${cleanText}`;
                        }
                    }
                }
            }
        } else if (state.bibleVersion === 'KKJV' && KKJV_DATA) {
            const bookData = KKJV_DATA.books[bookInfo.id - 1];
            if (bookData && bookData.chapters[chapter - 1]) {
                const chapterData = bookData.chapters[chapter - 1];
                const versesInRange = chapterData.verses.filter(v => v.verse >= vStart && v.verse <= vEnd);
                versesInRange.forEach(v => {
                    if (vStart === vEnd) {
                        fullVerseText += ` ${v.text}`;
                    } else {
                        fullVerseText += ` [${v.verse}] ${v.text}`;
                    }
                });
            }
        } else {
            const response = await fetch(`${CONFIG.BIBLE_API}/get-text/${state.bibleVersion}/${bookInfo.id}/${chapter}/`);
            const data = await response.json();
            if (data && data.length > 0) {
                const filtered = data.filter(v => v.verse >= vStart && v.verse <= vEnd);
                filtered.forEach(v => {
                    if (vStart === vEnd) {
                        fullVerseText += ` ${v.text}`;
                    } else {
                        fullVerseText += ` [${v.verse}] ${v.text}`;
                    }
                });
            }
        }

        if (fullVerseText) {
            const fontFamily = "'Nanum Myeongjo', '나눔명조', serif";
            const insertHTML = `<span class="bible-verse-inline" style="font-family:${fontFamily}; font-style: normal;">[${displayRef}]${fullVerseText}&nbsp;</span>`;
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('insertHTML', false, insertHTML);

            // ✅ FIX #2: 성경구절 삽입 후 커서를 span 밖으로 이동 (폰트 유지)
            const currentEditor = range.commonAncestorContainer.nodeType === Node.TEXT_NODE 
                ? range.commonAncestorContainer.parentElement.closest('.sermon-editor')
                : range.commonAncestorContainer.closest('.sermon-editor');
            if (currentEditor) {
                currentEditor.focus();
                // 삽입된 bible-verse-inline span 뒤로 커서 이동
                const sel2 = window.getSelection();
                if (sel2 && sel2.rangeCount > 0) {
                    const r2 = sel2.getRangeAt(0);
                    let node = r2.startContainer;
                    // span 안에 있으면 밖으로 탈출
                    let inlineSpan = null;
                    let checkNode = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
                    while (checkNode && checkNode !== currentEditor) {
                        if (checkNode.classList && checkNode.classList.contains('bible-verse-inline')) {
                            inlineSpan = checkNode;
                            break;
                        }
                        checkNode = checkNode.parentElement;
                    }
                    if (inlineSpan) {
                        const afterSpan = document.createRange();
                        afterSpan.setStartAfter(inlineSpan);
                        afterSpan.collapse(true);
                        // 커서 뒤에 빈 텍스트 노드 삽입 (span 밖 스타일 초기화)
                        const emptyText = document.createTextNode('\u200B');
                        afterSpan.insertNode(emptyText);
                        afterSpan.setStartAfter(emptyText);
                        afterSpan.collapse(true);
                        sel2.removeAllRanges();
                        sel2.addRange(afterSpan);
                    }
                }
            }
            autoSave();
        }
    } catch (e) { console.error("Auto Insert Error", e); }
}

function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('app_theme', state.theme);
    applyTheme();
    showToast(state.theme === 'light' ? '밝은 테마' : '어두운 테마');
}

function applyTheme() {
    document.body.classList.toggle('dark-theme', state.theme === 'dark');
    const themeBtn = document.getElementById('theme-toggle-btn');
    const editorThemeBtn = document.getElementById('editor-theme-toggle');
    const icon = state.theme === 'light' ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
    if (themeBtn) themeBtn.innerHTML = icon;
    if (editorThemeBtn) editorThemeBtn.innerHTML = icon;
}

function changeFontSizeTo(size) {
    state.fontSize = Math.max(12, Math.min(40, size));
    localStorage.setItem('app_font_size', state.fontSize);
    localStorage.setItem('app_font_size_changed_at', Date.now().toString());
    applyFontSize();
    debouncedSyncToFirestore(); // 잦은 동기화 방지
}

function applyFontFamily() {
    const editors = document.querySelectorAll('.sermon-editor');
    if (editors.length === 0) return;
    
    const editorArea = document.querySelector('.editor-area');
    const scrollTop = editorArea ? editorArea.scrollTop : 0;
    
    editors.forEach(editor => {
        editor.style.fontFamily = state.fontFamily;
    });
    
    if (editorArea) {
        requestAnimationFrame(() => {
            editorArea.scrollTop = scrollTop;
        });
    }
}

function applyFontSize() {
    const editors = document.querySelectorAll('.sermon-editor');
    if (editors.length === 0) return;
    
    const editorArea = document.querySelector('.editor-area');
    const scrollTop = editorArea ? editorArea.scrollTop : 0;
    
    editors.forEach(targetEditor => {
        targetEditor.style.fontSize = state.fontSize + 'px';

        const editorAreaEl = targetEditor.closest('.editor-area');
        if (editorAreaEl) {
            let currentLH = parseFloat(localStorage.getItem('noteLineHeight') || '1.7');
            if (isNaN(currentLH)) currentLH = 1.7;
            const currentBgOffset = parseFloat(localStorage.getItem('noteBgOffset') || '0');
            const linePx = state.fontSize * currentLH + currentBgOffset;

            targetEditor.style.backgroundOrigin = 'content-box';

            if (editorAreaEl.classList.contains('note-lined')) {
                targetEditor.style.backgroundSize = `100% ${linePx}px`;
                targetEditor.style.backgroundPosition = `0 0`;
            } else if (editorAreaEl.classList.contains('note-grid') || editorAreaEl.classList.contains('note-dotted')) {
                targetEditor.style.backgroundSize = `${linePx}px ${linePx}px`;
                targetEditor.style.backgroundPosition = `0 0, 0 0`;
            } else {
                targetEditor.style.backgroundSize = '';
                targetEditor.style.backgroundPosition = '';
            }
        }
    });

    if (elements.verseGallery) {
        elements.verseGallery.style.fontSize = (state.fontSize - 2) + 'px';
    }
    
    if (editorArea) {
        requestAnimationFrame(() => {
            editorArea.scrollTop = scrollTop;
        });
    }
}

// ==========================================
// Admin Dashboard Logic
// ==========================================
const hiddenAdminKey = document.getElementById('hidden-admin-key');
const adminPasswordModal = document.getElementById('admin-password-modal');
const adminPasswordInput = document.getElementById('input-admin-password');
const adminPasswordConfirmBtn = document.getElementById('admin-password-confirm-btn');
const adminPasswordCancelBtn = document.getElementById('admin-password-cancel-btn');

function showAdminPasswordModal() {
    if (!adminPasswordModal || !adminPasswordInput) return;
    adminPasswordInput.value = '';
    adminPasswordModal.classList.add('active');
    setTimeout(() => adminPasswordInput.focus(), 300);
}

function closeAdminPasswordModal() {
    if (adminPasswordModal) {
        adminPasswordModal.classList.remove('active');
    }
}

async function verifyAdminPassword() {
    if (!adminPasswordInput) return;
    const password = adminPasswordInput.value.trim();

    let adminPassword = '';
    try {
        const config = db ? await db.collection('users').doc('_ADMIN_CONFIG_').get() : null;
        adminPassword = config && config.exists ? (config.data().admin_password || '') : '';
    } catch (error) {
        console.error('관리자 설정을 불러올 수 없습니다.', error);
        showToast('관리자 설정을 불러올 수 없습니다.', 'error');
        return;
    }

    if (!adminPassword) {
        showToast('관리자 비밀번호가 아직 설정되지 않았습니다.', 'warning');
        return;
    }

    if (password === adminPassword) {
        closeAdminPasswordModal();
        switchView('admin');
        fetchAdminData();
    } else if (password) {
        adminPasswordInput.style.borderColor = '#ef4444';
        adminPasswordInput.value = '';
        adminPasswordInput.placeholder = '⚠️ 비밀번호가 틀렸습니다.';
        adminPasswordInput.focus();
        setTimeout(() => {
            adminPasswordInput.style.borderColor = '';
            adminPasswordInput.placeholder = '비밀번호 입력';
        }, 2000);
    }
}

// 5초 롱프레스 로직
function setupAdminLongPress(btn) {
    let pressTimer;
    let isLongPress = false;

    const startPress = (e) => {
        isLongPress = false;
        pressTimer = setTimeout(() => {
            isLongPress = true;
            showAdminPasswordModal();
        }, 5000);
    };

    const cancelPress = (e) => {
        clearTimeout(pressTimer);
        // 만약 5초가 지나 롱프레스가 발동되었다면 클릭(테마 변경) 방지
        if (isLongPress && e.cancelable) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    // prevent default toggle if long press
    btn.addEventListener('click', (e) => {
        if (isLongPress) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    });

    btn.addEventListener('mousedown', startPress);
    btn.addEventListener('touchstart', startPress, {passive: true});
    btn.addEventListener('mouseup', cancelPress);
    btn.addEventListener('mouseleave', cancelPress);
    btn.addEventListener('touchend', cancelPress);
}

if (adminPasswordCancelBtn) {
    adminPasswordCancelBtn.addEventListener('click', closeAdminPasswordModal);
}

if (adminPasswordConfirmBtn) {
    adminPasswordConfirmBtn.addEventListener('click', verifyAdminPassword);
}

if (adminPasswordInput) {
    adminPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verifyAdminPassword();
    });
}

const exitAdminBtn = document.getElementById('exit-admin-btn');
if (exitAdminBtn) {
    exitAdminBtn.addEventListener('click', () => {
        state.adminTargetDocId = null; // Reset
        switchView('home');
        // Refresh local data to ensure we are back to our own data
        init(); 
    });
}

let adminAllDocs = [];

window.renderAdminUserList = function(query, showNamesOnly = false) {
    const listContainer = document.getElementById('admin-user-list');
    let html = '';
    
    if (!query && !showNamesOnly) {
        listContainer.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">성도명을 입력하시면 메시지가 표시됩니다.</div>';
        return;
    }
    
    let filteredDocs = adminAllDocs;
    if (query) {
        filteredDocs = adminAllDocs.filter(d => {
            const name = d.data.identity?.name || '';
            return name.includes(query);
        });
    }
    
    if (filteredDocs.length === 0) {
        listContainer.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">검색 결과가 없습니다.</div>';
        return;
    }
    
    filteredDocs.forEach(userDoc => {
        const docId = userDoc.id;
        const userData = userDoc.data;
        const iden = userData.identity || { gyogu: '미지정', sel: '미지정', name: '알수없음' };
        const notes = userData.notes || {};
        
        if (showNamesOnly) {
            html += `
                <div class="admin-user-card" style="cursor: pointer;" onclick="document.getElementById('admin-user-search').value = '${iden.name}'; window.renderAdminUserList('${iden.name}', false);">
                    <div class="admin-user-header" style="border-bottom: none; padding-bottom: 0;">
                        <div class="admin-user-title">${iden.gyogu} 교구 > ${iden.sel} 셀 > ${iden.name}</div>
                        <div style="font-size: 0.75rem; color: var(--text-muted);">총 ${Object.keys(notes).length}개 기록</div>
                    </div>
                </div>
            `;
        } else {
            const sortedNotes = Object.keys(notes)
                .map(k => ({ id: k, ...notes[k] }))
                .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

            let notesHtml = '';
            if (sortedNotes.length === 0) {
                notesHtml = '<div class="admin-note-item" style="cursor: default;"><div class="admin-note-info" style="color: var(--text-muted);">아직 기록된 설교가 없습니다.</div></div>';
            } else {
                sortedNotes.forEach(note => {
                    const preview = note.content ? note.content.replace(/<[^>]+>/g, '').substring(0, 30) + '...' : '(내용 없음)';
                    const dateStr = note.isoDate || new Date(note.timestamp || Date.now()).toLocaleDateString();
                    notesHtml += `
                        <div class="admin-note-item" onclick="window.openAdminNote('${docId}', '${note.id}')">
                            <div>
                                <div class="admin-note-info">${note.worshipType || '주일예배'} - ${note.title || '제목 없음'}</div>
                                <div class="admin-note-date">${dateStr} | ${preview}</div>
                            </div>
                            <i class="fas fa-chevron-right" style="color: var(--text-muted); font-size: 0.8rem;"></i>
                        </div>
                    `;
                });
            }

            html += `
                <div class="admin-user-card">
                    <div class="admin-user-header">
                        <div class="admin-user-title">${iden.gyogu} 교구 > ${iden.sel} 셀 > ${iden.name}</div>
                        <div style="font-size: 0.75rem; color: var(--text-muted);">총 ${Object.keys(notes).length}개 기록</div>
                    </div>
                    ${notesHtml}
                </div>
            `;
        }
    });
    
    listContainer.innerHTML = html;
};

async function fetchAdminData() {
    const listContainer = document.getElementById('admin-user-list');
    const searchInput = document.getElementById('admin-user-search');
    const showUsersBtn = document.getElementById('admin-show-users-btn');
    
    // ✅ 즉각 스켈레톤 UI 표시 (체감 속도 향상)
    const skeletonHTML = `
        <div style="display:flex;flex-direction:column;gap:0.75rem;padding:0.5rem 0;">
            ${[1,2,3].map(() => `
                <div style="background:var(--bg-card);border-radius:12px;padding:1rem;border:1px solid var(--border-color);">
                    <div style="height:14px;background:var(--border-color);border-radius:6px;width:60%;margin-bottom:0.6rem;animation:pulse 1.2s ease-in-out infinite;"></div>
                    <div style="height:11px;background:var(--border-color);border-radius:6px;width:35%;opacity:0.6;animation:pulse 1.2s ease-in-out infinite 0.2s;"></div>
                </div>
            `).join('')}
        </div>
    `;
    listContainer.innerHTML = skeletonHTML;
    
    if (!db) {
        listContainer.innerHTML = '<div style="color: #ef4444; padding: 1.5rem; text-align: center;"><i class="fas fa-exclamation-triangle" style="font-size: 2rem; margin-bottom: 0.5rem; display: block;"></i>데이터베이스 서버와 연결되지 않았습니다.<br><span style="font-size: 0.8rem; color: var(--text-muted);">인터넷 연결을 확인하고 새로고침해 주세요.</span></div>';
        return;
    }

    try {
        // ✅ 인증 대기 (이미 로그인되어 있으면 즉시 통과)
        let currentUser = firebase.auth().currentUser;
        if (!currentUser) {
            try {
                await Promise.race([
                    new Promise((resolve) => {
                        const unsub = firebase.auth().onAuthStateChanged((user) => {
                            if (user) { unsub(); resolve(user); }
                        });
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
                ]);
            } catch (e) {
                console.warn('Auth timeout, proceeding anyway');
            }
        }

        // ✅ 통계(config doc)와 유저 목록을 병렬로 패치 → 레이턴시 50% 감소
        const [configSnap, usersSnap] = await Promise.all([
            db.collection('users').doc('_ADMIN_CONFIG_').get().catch(() => null),
            db.collection('users').get()
        ]);

        // 통계 즉시 표시
        const visits = configSnap?.exists ? (configSnap.data().visits || 0) : 0;

        const docs = [];
        let totalUsers = 0;
        let totalNotes = 0;
        
        usersSnap.forEach(doc => {
            if (doc.id === '_ADMIN_CONFIG_') return;
            const data = doc.data();
            if (data && data.identity) {
                docs.push({ id: doc.id, data });
                totalUsers++;
                totalNotes += Object.keys(data.notes || {}).length;
            }
        });

        docs.sort((a, b) => (b.data.lastUpdated || 0) - (a.data.lastUpdated || 0));
        adminAllDocs = docs;

        // ✅ 통계 UI 업데이트 (자연스러운 애니메이션)
        const animateCount = (el, target) => {
            if (!el) return;
            const duration = 600;
            const start = performance.now();
            const update = (now) => {
                const progress = Math.min((now - start) / duration, 1);
                el.textContent = Math.round(progress * target);
                if (progress < 1) requestAnimationFrame(update);
            };
            requestAnimationFrame(update);
        };
        animateCount(document.getElementById('admin-stat-users'), totalUsers);
        animateCount(document.getElementById('admin-stat-notes'), totalNotes);
        animateCount(document.getElementById('admin-stat-visits'), visits);

        // ✅ 검색 & 버튼 이벤트 연결
        if (searchInput) {
            searchInput.oninput = () => window.renderAdminUserList(searchInput.value.trim(), false);
        }
        if (showUsersBtn) {
            showUsersBtn.onclick = () => {
                if (searchInput) searchInput.value = '';
                window.renderAdminUserList('', true);
            };
        }

        window.renderAdminUserList('', false);
        
    } catch (e) {
        console.error("Failed to fetch admin data", e);
        listContainer.innerHTML = `<div style="color: #ef4444; padding: 1rem;">오류가 발생했습니다: ${e.message}</div>`;
    }
}


window.openAdminNote = async (docId, noteId) => {
    state.adminTargetDocId = docId; // Set target for syncToFirestore
    
    // Fetch that specific user's document
    try {
        const doc = await db.collection('users').doc(docId).get();
        if (doc.exists) {
            const userData = doc.data();
            const notes = userData.notes || {};
            if (notes[noteId]) {
                // Temporarily load this user's notes into state so the editor can use them
                state.notes = notes;
                
                loadNote(noteId);
                
                showToast('관리자 권한으로 수정 모드 진입', 'info', 3000);
            }
        }
    } catch (e) {
        console.error(e);
        alert('기록을 불러오는데 실패했습니다.');
    }
};
window.addEventListener('DOMContentLoaded', () => {
    // 자동 페이지 생성 기능은 버그 발생으로 비활성화
    // 사용자가 하단 + 버튼으로만 새 페이지 추가 가능

    // --- 뒤로가기(하드웨어 버튼) 지원을 위한 History API 초기화 (해시 변경으로 인한 주소창 노출 방지를 위해 임시 비활성화) ---
    // history.replaceState({ view: 'exit' }, '', '#exit');
    // history.pushState({ view: 'home' }, '', '#home');

    // window.addEventListener('popstate', (e) => {
    //     if (!e.state) return;
    //     if (e.state.view === 'exit') {
    //         if (confirm('앱을 종료하시겠습니까?')) {
    //             history.back();
    //         } else {
    //             history.pushState({ view: 'home' }, '', '#home');
    //             switchView('home', false);
    //         }
    //     } else {
    //         switchView(e.state.view, false);
    //     }
    // });
    // --------------------------------------------------------
    // --------------------------------------------------------

    init();
    applyFontSize();
    initNoteStylePicker();
    fixToolbarLayout();

});

// 패널 위치 재배치 (아래로 펼쳐지게)
function fixToolbarLayout() {
    const toolbar = document.querySelector('.modern-format-toolbar');
    const textPanel = document.getElementById('text-format-panel');
    const penPanel = document.getElementById('pen-format-panel');
    if (toolbar && textPanel && penPanel) {
        // 툴바의 바로 뒤(형제 노드)로 이동시켜서 아래로 열리도록 구조 변경
        toolbar.parentElement.insertBefore(textPanel, toolbar.nextSibling);
        toolbar.parentElement.insertBefore(penPanel, toolbar.nextSibling);
    }
}

// ==========================================
// Note Style & Background Picker
// ==========================================
function initNoteStylePicker() {
    const toggleBgSwatches = document.getElementById('toggle-bg-swatches');
    const bgSwatches = document.getElementById('bg-swatches');
    if (toggleBgSwatches && bgSwatches) {
        toggleBgSwatches.addEventListener('click', () => {
            if (bgSwatches.style.display === 'none') {
                bgSwatches.style.display = 'flex';
                // ✅ FIX #1: scrollIntoView 제거 - 스크롤 탑 방지
            } else {
                bgSwatches.style.display = 'none';
            }
        });
    }

    const NOTE_STYLES = ['none', 'lined', 'grid', 'dotted', 'music'];
    const styleClassMap = {
        lined: 'note-lined',
        grid:  'note-grid',
        dotted: 'note-dotted',
        music: 'note-music',
    };

    // Restore saved settings
    const savedStyle = localStorage.getItem('noteLineStyle') || 'none';
    const savedBg    = localStorage.getItem('noteBgColor')   || 'default';
    applyNoteStyle(savedStyle);
    applyNoteBg(savedBg);
    syncStyleBtns(savedStyle);
    syncBgSwatches(savedBg);

    // ── 이벤트 위임: document 레벨에서 처리 (DOM 타이밍 문제 완전 해결) ──
    // 이미 등록됐으면 중복 등록 방지
    if (!window._noteStyleListenerAdded) {
        window._noteStyleListenerAdded = true;
        
        const collapsePageStylePanels = () => {
            const panelPageStyle = document.getElementById('page-style-panel');
            const btnPageStyle = document.getElementById('btn-page-style');
            const rowLineStyle = document.getElementById('row-line-style');
            const rowBgColor = document.getElementById('row-bg-color');
            const btnLineStyleToggle = document.getElementById('btn-line-style-toggle');
            const btnBgColorToggle = document.getElementById('btn-bg-color-toggle');
            if (rowLineStyle) rowLineStyle.style.display = 'none';
            if (rowBgColor) rowBgColor.style.display = 'none';
            if (btnLineStyleToggle) btnLineStyleToggle.classList.remove('active');
            if (btnBgColorToggle) btnBgColorToggle.classList.remove('active');
            if (panelPageStyle) panelPageStyle.style.display = 'none';
            if (btnPageStyle) btnPageStyle.classList.remove('active');
        };

        document.addEventListener('click', (e) => {
            // 줄모양 버튼
            const styleBtn = e.target.closest('.notestyle-btn[data-style]');
            if (styleBtn) {
                e.preventDefault();
                const style = styleBtn.dataset.style;
                if (style) {
                    applyNoteStyle(style);
                    syncStyleBtns(style);
                    localStorage.setItem('noteLineStyle', style);
                    collapsePageStylePanels();
                }
                return;
            }
            // 배경색 스와치
            const bgBtn = e.target.closest('.bg-swatch[data-bg]');
            if (bgBtn) {
                e.preventDefault();
                const bg = bgBtn.dataset.bg;
                applyNoteBg(bg);
                syncBgSwatches(bg);
                localStorage.setItem('noteBgColor', bg);
                collapsePageStylePanels();
                return;
            }
        });

        document.addEventListener('touchend', (e) => {
            // 줄모양 버튼 터치
            const styleBtn = e.target.closest('.notestyle-btn[data-style]');
            if (styleBtn) {
                e.preventDefault();
                const style = styleBtn.dataset.style;
                if (style) {
                    applyNoteStyle(style);
                    syncStyleBtns(style);
                    localStorage.setItem('noteLineStyle', style);
                    collapsePageStylePanels();
                }
                return;
            }
            // 배경색 스와치 터치
            const bgBtn = e.target.closest('.bg-swatch[data-bg]');
            if (bgBtn) {
                e.preventDefault();
                const bg = bgBtn.dataset.bg;
                applyNoteBg(bg);
                syncBgSwatches(bg);
                localStorage.setItem('noteBgColor', bg);
                collapsePageStylePanels();
                return;
            }
        }, { passive: false });
    }

    function applyNoteStyle(style) {
        const editorArea = document.querySelector('.editor-area');
        if (!editorArea) return;
        Object.values(styleClassMap).forEach(cls => editorArea.classList.remove(cls));
        if (style && styleClassMap[style]) {
            editorArea.classList.add(styleClassMap[style]);
        }
        applyFontSize();
    }

    function applyNoteBg(bg) {
        const editors = document.querySelectorAll('.sermon-editor');
        const wrappers = document.querySelectorAll('.a4-page-wrapper');
        const editorArea = document.querySelector('.editor-area');
        
        editors.forEach(editor => {
            editor.style.setProperty('background-color', 'transparent', 'important');
            const isDark = bg === '#1e293b' || bg === '#422006';
            editor.style.color = (bg !== 'default' && isDark) ? '#f1f5f9' : '';
        });
        
        wrappers.forEach(wrapper => {
            wrapper.style.setProperty('background-color', 'transparent', 'important');
        });
        
        if (editorArea) {
            if (bg === 'default') {
                editorArea.style.removeProperty('background-color');
            } else {
                editorArea.style.setProperty('background-color', bg, 'important');
            }
        }
    }

    function syncStyleBtns(activeStyle) {
        document.querySelectorAll('.notestyle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.style === activeStyle);
        });
    }

    function syncBgSwatches(activeBg) {
        document.querySelectorAll('.bg-swatch').forEach(s => {
            s.classList.toggle('active', s.dataset.bg === activeBg);
            if (s.dataset.bg === activeBg) {
                s.style.boxShadow = '0 0 0 2.5px var(--accent-primary)';
            } else {
                s.style.boxShadow = '';
            }
        });
    }

    // ── Line Height Controls ──
    const LH_MIN  = 0.8;
    const LH_MAX  = 3.5;
    const LH_STEP = 0.1;
    const lhDisplay  = document.getElementById('lh-display');
    const lhDecrease = document.getElementById('lh-decrease');
    const lhIncrease = document.getElementById('lh-increase');
    const bgLhDecrease = document.getElementById('bg-lh-decrease');
    const bgLhIncrease = document.getElementById('bg-lh-increase');
    const editor     = document.querySelector('.sermon-editor');

    let currentLH = parseFloat(localStorage.getItem('noteLineHeight') || '1.7');
    if (isNaN(currentLH)) currentLH = 1.7;
    let currentBgOffset = parseFloat(localStorage.getItem('noteBgOffset') || '0');
    applyLineHeight(currentLH);

    // The select logic for 'note-style-lined' has been removed as it is now a button.

    if (bgLhDecrease) {
        bgLhDecrease.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentBgOffset -= 1;
            localStorage.setItem('noteBgOffset', currentBgOffset);
            applyLineHeight(currentLH);
        });
    }
    if (bgLhIncrease) {
        bgLhIncrease.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentBgOffset += 1;
            localStorage.setItem('noteBgOffset', currentBgOffset);
            applyLineHeight(currentLH);
        });
    }

    if (lhDecrease) {
        lhDecrease.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentLH = Math.max(LH_MIN, parseFloat((currentLH - LH_STEP).toFixed(1)));
            applyLineHeight(currentLH);
            localStorage.setItem('noteLineHeight', currentLH);
        });
    }
    if (lhIncrease) {
        lhIncrease.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentLH = Math.min(LH_MAX, parseFloat((currentLH + LH_STEP).toFixed(1)));
            applyLineHeight(currentLH);
            localStorage.setItem('noteLineHeight', currentLH);
        });
    }

    function applyLineHeight(lh) {
        if (editor) editor.style.lineHeight = lh;
        applyFontSize();
        if (lhDisplay) lhDisplay.textContent = lh.toFixed(1);
    }
}

// ==========================================
// YouTube Integration Logic
// ==========================================
function getYoutubeModalElements() {
    return {
        modal: document.getElementById('youtube-video-modal'),
        body: document.getElementById('youtube-modal-body'),
        title: document.getElementById('youtube-modal-title'),
        closeBtn: document.getElementById('close-youtube-modal')
    };
}

// Attach close listener globally if possible
document.addEventListener('click', (e) => {
    if (e.target.closest('#close-youtube-modal')) {
        const els = getYoutubeModalElements();
        if (els.modal) els.modal.classList.remove('active');
        if (els.body) els.body.innerHTML = '';
    }
});

async function openYouTubeModal(yearMonth, label) {
    const els = getYoutubeModalElements();
    if (!els.modal || !els.title || !els.body) {
        console.error("YouTube modal elements not found in DOM");
        return;
    }
    
    els.title.innerHTML = `<i class="fab fa-youtube"></i> ${label} 영상`;
    els.body.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 2rem;"><i class="fas fa-spinner fa-spin fa-2x"></i><br><br>영상을 불러오는 중입니다...</div>`;
    els.modal.classList.add('active');

    try {
        const rssUrl = encodeURIComponent('https://www.youtube.com/feeds/videos.xml?channel_id=UCSTU7FxiloGVnHnu0xNy4Yw');
        const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${rssUrl}`);
        const data = await res.json();
        
        if (data.status !== 'ok') throw new Error('API fetch failed');
        
        // Filter by month
        const matchedItems = data.items.filter(item => {
            const pubDate = new Date(item.pubDate);
            const itemYearMonth = `${pubDate.getFullYear()}-${String(pubDate.getMonth()+1).padStart(2,'0')}`;
            return itemYearMonth === yearMonth;
        });

        if (matchedItems.length === 0) {
            els.body.innerHTML = `
                <div style="text-align: center; padding: 2rem;">
                    <i class="fas fa-video-slash fa-3x" style="color: var(--text-muted); margin-bottom: 1rem;"></i>
                    <p style="color: var(--text-main); font-weight: 700; margin-bottom: 0.5rem;">해당 월의 영상을 찾을 수 없습니다.</p>
                    <p style="color: var(--text-muted); font-size: 0.85rem; line-height: 1.4;">유튜브 제약으로 최근 영상 15개 중에서만 검색 가능합니다. 더 오래된 영상은 채널에서 직접 확인해 주세요.</p>
                    <a href="https://www.youtube.com/@skyforest_church/videos" target="_blank" class="primary-btn" style="display: inline-block; margin-top: 1.5rem; text-decoration: none; padding: 0.6rem 1.2rem; border-radius: 8px;"><i class="fab fa-youtube"></i> 채널 직접 방문하기</a>
                </div>
            `;
            return;
        }

        let html = '';
        matchedItems.forEach(item => {
            let videoId = '';
            const match = item.link.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
            if (match && match[1]) {
                videoId = match[1];
            } else {
                if (item.link.includes('v=')) videoId = item.link.split('v=')[1].split('&')[0];
                else if (item.link.includes('youtu.be/')) videoId = item.link.split('youtu.be/')[1].split('?')[0];
                else if (item.link.includes('/shorts/')) videoId = item.link.split('/shorts/')[1].split('?')[0];
            }

            if (!videoId) return;

            const pubDateStr = new Date(item.pubDate).toLocaleDateString('ko-KR');

            html += `
                <div class="youtube-item" style="margin-bottom: 1.5rem;">
                    <div class="youtube-iframe-container">
                        <iframe src="https://www.youtube-nocookie.com/embed/${videoId}?origin=https://prayer-note-ee540.web.app&rel=0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
                    </div>
                    <div class="youtube-video-title">${item.title}</div>
                    <div class="youtube-video-date">${pubDateStr}</div>
                </div>
            `;
        });
        els.body.innerHTML = html;

    } catch (err) {
        console.error('YouTube Fetch Error:', err);
        els.body.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: #ef4444;">
                <i class="fas fa-exclamation-triangle fa-2x"></i>
                <p style="margin-top: 1rem; font-weight: 700;">영상 목록을 불러오지 못했습니다.</p>
            </div>
        `;
    }
}

/* ==========================================================================
   날씨 인사 기능
   ========================================================================== */
function fetchWeatherGreeting() {
    if (isWeatherFetched) return;
    isWeatherFetched = true;

    // 1시간 캐시 확인
    const cached = localStorage.getItem('app_weather_cache');
    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            if (Date.now() - parsed.timestamp < 3600000) {
                applyWeatherCode(parsed.code);
                return;
            }
        } catch(e) {}
    }

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const { latitude, longitude } = position.coords;
                try {
                    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
                    const data = await res.json();
                    if (data && data.current_weather) {
                        const code = data.current_weather.weathercode;
                        localStorage.setItem('app_weather_cache', JSON.stringify({
                            code: code,
                            timestamp: Date.now()
                        }));
                        applyWeatherCode(code);
                    } else {
                        applyWeatherCode(-1);
                    }
                } catch (e) {
                    console.error('Weather fetch error', e);
                    applyWeatherCode(-1);
                }
            },
            (error) => {
                console.log('Geolocation denied or error:', error);
                applyWeatherCode(-1);
            },
            { timeout: 10000 }
        );
    } else {
        applyWeatherCode(-1);
    }
}

// 크리스찬 관련 아름답고 은혜로운 고화질 배경 이미지 컬렉션 (20종 이상)
const CHRISTIAN_BG_IMAGES = [
    'https://images.unsplash.com/photo-1544717305-2782549b5136?auto=format&fit=crop&w=1200&q=80', // 십자가와 여명
    'https://images.unsplash.com/photo-1504052434569-70ad5836ab65?auto=format&fit=crop&w=1200&q=80', // 성경책과 빛
    'https://images.unsplash.com/photo-1507692049790-de58290a4334?auto=format&fit=crop&w=1200&q=80', // 성경과 촛불
    'https://images.unsplash.com/photo-1543807535-eceef0bc6599?auto=format&fit=crop&w=1200&q=80', // 기도하는 손과 온화한 빛
    'https://images.unsplash.com/photo-1519817650390-64a93db51149?auto=format&fit=crop&w=1200&q=80', // 스테인드글라스 빛
    'https://images.unsplash.com/photo-1509099836639-18ba1795216d?auto=format&fit=crop&w=1200&q=80', // 언덕 위 십자가와 햇살
    'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1200&q=80', // 구름 사이 은혜의 빛
    'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=1200&q=80', // 푸른 초장
    'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80', // 평강의 잔잔한 바다
    'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1200&q=80', // 감람산 올리브 숲
    'https://images.unsplash.com/photo-1499209974431-9dddcece7f88?auto=format&fit=crop&w=1200&q=80', // 아침 묵상
    'https://images.unsplash.com/photo-1438032005730-c779502df39b?auto=format&fit=crop&w=1200&q=80', // 고요한 예배당
    'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1200&q=80', // 밤하늘과 별
    'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?auto=format&fit=crop&w=1200&q=80', // 평화로운 들판
    'https://images.unsplash.com/photo-1455390582262-044cdead277a?auto=format&fit=crop&w=1200&q=80', // 펼쳐진 성경
    'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1200&q=80', // 아침 햇살과 산
    'https://images.unsplash.com/photo-1501862700950-18382cb914b1?auto=format&fit=crop&w=1200&q=80', // 주의 숲
    'https://images.unsplash.com/photo-1498623116890-37e912163d5d?auto=format&fit=crop&w=1200&q=80', // 맑은 시냇가
    'https://images.unsplash.com/photo-1511690655006-9051fc0f722c?auto=format&fit=crop&w=1200&q=80', // 따스한 빛
    'https://images.unsplash.com/photo-1515694346937-94d85e41e6f0?auto=format&fit=crop&w=1200&q=80'  // 평안한 노을
];

const FAITH_BIBLE_VERSES = [
    "여호와는 나의 목자시니 내게 부족함이 없으리로다 그가 나를 푸른 풀밭에 누이시며 쉴 만한 물 가로 인도하시는도다 (시 23:1-2)",
    "내가 사망의 음침한 골짜기로 다닐지라도 해를 두려워하지 않을 것은 주께서 나와 함께 하심이라 주의 지팡이와 막대기가 나를 안위하시나이다 (시 23:4)",
    "내 평생에 선하심과 인자하심이 반드시 나를 따르리니 내가 여호와의 집에 영원히 살리로다 (시 23:6)",
    "두려워하지 말라 내가 너와 함께 함이라 놀라지 말라 나는 네 하나님이 됨이라 내가 너를 굳세게 하리라 참으로 너를 도와 주리라 참으로 나의 의로운 오른손으로 너를 붙들리라 (사 41:10)",
    "수고하고 무거운 짐 진 자들아 다 내게로 오라 내가 너희를 쉬게 하리라 나는 마음이 온유하고 겸손하니 나의 멍에를 메고 내게 배우라 그리하면 너희 마음이 쉼을 얻으리니 (마 11:28-29)",
    "아무 것도 염려하지 말고 다만 모든 일에 기도와 간구로, 너희 구할 것을 감사함으로 하나님께 아뢰라 그리하면 모든 지각에 뛰어난 하나님의 평강이 그리스도 예수 안에서 너희 마음과 생각을 지키시리라 (빌 4:6-7)",
    "우리가 알거니와 하나님을 사랑하는 자 곧 그의 뜻대로 부르심을 입은 자들에게는 모든 것이 합력하여 선을 이루느니라 (롬 8:28)",
    "내가 확신하노니 사망이나 생명이나 천사들이나 권세자들이나 현재 일이나 장래 일이나 능력이나 높음이나 깊음이나 다른 어떤 피조물이라도 우리를 우리 주 그리스도 예수 안에 있는 하나님의 사랑에서 끊을 수 없으리라 (롬 8:38-39)",
    "너는 마음을 다하여 여호와를 신뢰하고 네 명철을 의지하지 말라 너는 범사에 그를 인정하라 그리하면 네 길을 지도하시리라 (잠 3:5-6)",
    "오직 여호와를 앙망하는 자는 새 힘을 얻으리니 독수리가 날개치며 올라감 같을 것이요 달음박질하여도 곤비하지 아니하겠고 걸어가도 피곤하지 아니하리로다 (사 40:31)",
    "내가 네게 명령한 것이 아니냐 강하고 담대하라 두려워하지 말며 놀라지 말라 네가 어디로 가든지 네 하나님 여호와가 너와 함께 하느니라 (수 1:9)",
    "여호와는 나의 빛이요 나의 구원이시니 내가 누구를 두려워하리요 여호와는 내 생명의 능력이시니 내가 누구를 무서워하리요 (시 27:1)",
    "하나님이 세상을 이처럼 사랑하사 독생자를 주셨으니 이는 그를 믿는 자마다 멸망하지 않고 영생을 얻게 하려 하심이라 (요 3:16)",
    "내가 평안히 눕고 자기도 하리니 나를 안전히 살게 하시는 이는 오직 여호와이시니이다 (시 4:8)",
    "너의 하나님 여호와가 너의 가운데에 계시니 그는 구원을 베푸실 전능자이시라 그가 너로 말미암아 기쁨을 이기지 못하시며 너를 잠잠히 사랑하시며 너로 말미암아 즐거이 부르며 기뻐하시리라 (습 3:17)",
    "너희 안에서 착한 일을 시작하신 이가 그리스도 예수의 날까지 이루실 줄을 우리는 확신하노라 (빌 1:6)",
    "너의 길을 여호와께 맡기라 그를 의지하면 그가 이루시고 네 의를 빛 같이 나타내시며 네 공의를 정오의 빛 같이 하시리로다 (시 37:5-6)",
    "사람이 마음으로 자기의 길을 계획할지라도 그의 걸음을 인도하시는 이는 여호와시니라 (잠 16:9)",
    "여호와께 감사하라 그는 선하시며 그의 인자하심이 영원함이로다 (시 107:1)",
    "평안을 너희에게 끼치노니 곧 나의 평안을 너희에게 주노라 내가 너희에게 주는 것은 세상이 주는 것과 같지 아니하니라 너희는 마음에 근심하지도 말고 두려워하지도 말라 (요 14:27)",
    "내가 산을 향하여 눈을 들리라 나의 도움이 어디서 올까 나의 도움은 천지를 지으신 여호와에게서로다 (시 121:1-2)",
    "여호와께서 너를 지켜 모든 환난을 면하게 하시며 또 네 영혼을 지키시리로다 여호와께서 너의 출입을 지금부터 영원까지 지키시리로다 (시 121:7-8)",
    "주께서 심지가 견고한 자를 평강하고 평강하도록 지키시리니 이는 그가 주를 신뢰함이니이다 (사 26:3)",
    "야곱아 너를 창조하신 여호와께서 지금 말씀하시느니라 이스라엘아 너를 지으신 이가 말씀하시느니라 너는 두려워하지 말라 내가 너를 구속하였고 내가 너를 지명하여 불렀나니 너는 내 것이라 (사 43:1)",
    "네가 물 가운데로 지날 때에 내가 너와 함께 할 것이라 강을 건널 때에 물이 너를 침몰하지 못할 것이며 네가 불 가운데로 지날 때에 타지도 아니할 것이요 불꽃이 너를 사르지도 못하리니 (사 43:2)",
    "여호와의 말씀이니라 너희를 향한 나의 생각을 내가 아나니 평안이요 재앙이 아니니라 너희에게 미래와 희망을 주는 것이니라 (렘 29:11)",
    "너희가 온 마음으로 나를 구하면 나를 찾을 것이요 나를 만나리라 (렘 29:13)",
    "일을 행하시는 여호와, 그것을 만들며 성취하시는 여호와, 그의 이름을 여호와라 하는 이가 이와 같이 이르시도다 너는 내게 부르짖으라 내가 네게 응답하겠고 네가 알지 못하는 크고 은밀한 일을 네게 보이리라 (렘 33:2-3)",
    "사랑은 오래 참고 사랑은 온유하며 시기하지 아니하며 사랑은 자랑하지 아니하며 교만하지 아니하며 (고전 13:4)",
    "그런즉 믿음, 소망, 사랑, 이 세 가지는 항상 있을 것인데 그 중의 제일은 사랑이라 (고전 13:13)",
    "비록 무화과나무가 무성하지 못하며 포도나무에 열매가 없으며 감람나무에 소출이 없으며 밭에 먹을 것이 없으며 우리에 양이 없으며 외양간에 소가 없을지라도 나는 여호와로 말미암아 즐거워하며 나의 구원의 하나님으로 말미암아 기뻐하리로다 (하 3:17-18)",
    "주 여호와는 나의 힘이시라 나의 발을 사슴과 같게 하사 나를 나의 높은 곳으로 다니게 하시리로다 (하 3:19)",
    "오직 성령의 열매는 사랑과 희락과 화평과 오래 참음과 자비와 양선과 충성과 온유와 절제니 이같은 것을 금지할 법이 없느니라 (갈 5:22-23)",
    "여호와는 나의 반석이시요 나의 요새시요 나를 건지시는 이시요 나의 하나님이시요 내가 그 안에 피할 나의 바위시요 나의 방패시요 나의 구원의 뿔이시요 나의 산성이시로다 (시 18:2)",
    "주의 말씀은 내 발에 등이요 내 길에 빛이니이다 (시 119:105)",
    "보라 내가 새 일을 행하리니 이제 나타낼 것이라 너희가 그것을 알지 못하겠느냐 반드시 내가 광야에 길을 사막에 강을 내리니 (사 43:19)",
    "여호와는 은혜로우시며 의로우시며 우리 하나님은 긍휼이 많으시도다 여호와께서는 순진한 자를 지키시나니 내가 어려울 때에 나를 구원하셨도다 (시 116:5-6)",
    "너희는 먼저 그의 나라와 그의 의를 구하라 그리하면 이 모든 것을 너희에게 더하시리라 (마 6:33)",
    "내 형제들아 너희가 여러 가지 시험을 당하거든 온전히 기쁘게 여기라 이는 너희 믿음의 시련이 인내를 만들어 내는 줄 너희가 앎이라 (약 1:2-3)",
    "구하라 그리하면 너희에게 주실 것이요 찾으라 그리하면 찾아낼 것이요 문을 두드리라 그리하면 너희에게 열릴 것이니 (마 7:7)",
    "하나님은 영이시니 예배하는 자가 영과 진리로 예배할지니라 (요 4:24)",
    "내게 능력 주시는 자 안에서 내가 모든 것을 할 수 있느니라 (빌 4:13)",
    "항상 기뻐하라 쉬지 말고 기도하라 범사에 감사하라 이것이 그리스도 예수 안에서 너희를 향하신 하나님의 뜻이니라 (살전 5:16-18)",
    "주의 성실하심이 아침마다 새로우니 주의 인자하심이 크시도소이다 (애 3:23)",
    "나의 영혼이 잠잠히 하나님만 바람이여 나의 구원이 그에게서 나오는도다 (시 62:1)",
    "하나님은 우리의 피난처시요 힘이시니 환난 중에 만날 큰 도움이시라 그러므로 땅이 변하든지 산이 흔들려 바다 가운데에 빠지든지 우리는 두려워하지 아니하리로다 (시 46:1-2)",
    "너희는 세상의 빛이라 산 위에 있는 동네가 숨겨지지 못할 것이요 이같이 너희 빛이 사람 앞에 비치게 하여 그들로 너희 착한 행실을 보고 하늘에 계신 너희 아버지께 영광을 돌리게 하라 (마 5:14, 16)"
];

// 신앙 동행(방문 이력) 로컬스토리지 누적 관리
function updateFaithVisitRecord() {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        let lastVisit = localStorage.getItem('faith_last_visit_date');
        let streak = parseInt(localStorage.getItem('faith_visit_streak') || '1', 10);
        let totalVisits = parseInt(localStorage.getItem('faith_total_visits') || '1', 10);

        if (lastVisit !== todayStr) {
            if (lastVisit) {
                const lastDate = new Date(lastVisit);
                const todayDate = new Date(todayStr);
                const diffDays = Math.round((todayDate - lastDate) / (1000 * 60 * 60 * 24));
                if (diffDays === 1) {
                    streak += 1;
                } else if (diffDays > 1) {
                    streak = 1;
                }
                totalVisits += 1;
            } else {
                streak = 1;
                totalVisits = 1;
            }
            localStorage.setItem('faith_last_visit_date', todayStr);
            localStorage.setItem('faith_visit_streak', streak.toString());
            localStorage.setItem('faith_total_visits', totalVisits.toString());
        }

        const streakEl = document.getElementById('stat-visit-streak');
        if (streakEl) streakEl.textContent = `${streak}일째`;
    } catch(e) {
        console.warn('updateFaithVisitRecord error:', e);
    }
}

// 메인 말씀카드 배경 및 성경구절 새로고침 함수
function refreshFaithVerseAndBg() {
    const heroEl = document.getElementById('home-hero-card') || document.querySelector('.home-hero');
    const verseEl = document.getElementById('home-verse');
    
    // 무작위 크리스찬 배경 이미지
    const randomBg = CHRISTIAN_BG_IMAGES[Math.floor(Math.random() * CHRISTIAN_BG_IMAGES.length)];
    if (heroEl) {
        heroEl.style.backgroundImage = `url('${randomBg}')`;
    }

    // 무작위 성경 구절
    if (verseEl) {
        const randomVerse = FAITH_BIBLE_VERSES[Math.floor(Math.random() * FAITH_BIBLE_VERSES.length)];
        verseEl.style.opacity = '0';
        setTimeout(() => {
            verseEl.textContent = randomVerse;
            verseEl.style.opacity = '1';
        }, 150);
    }
}

function applyWeatherCode(code) {
    let icon = '☁️';
    if (code === 0) icon = '☀️';
    else if (code >= 1 && code <= 3) icon = '⛅';
    else if (code >= 45 && code <= 48) icon = '🌫️';
    else if (code >= 51 && code <= 67) icon = '🌧️';
    else if (code >= 71 && code <= 77) icon = '❄️';
    else if (code >= 80 && code <= 82) icon = '🌦️';
    else if (code >= 95 && code <= 99) icon = '⛈️';

    const greetingEl = document.getElementById('home-greeting');
    const verseEl = document.getElementById('home-verse');
    const heroEl = document.getElementById('home-hero-card') || document.querySelector('.home-hero');
    
    if (heroEl) {
        // 크리스찬 관련 아름다운 배경 무작위 적용
        const randomBg = CHRISTIAN_BG_IMAGES[Math.floor(Math.random() * CHRISTIAN_BG_IMAGES.length)];
        heroEl.style.backgroundImage = `url('${randomBg}')`;
    }

    if (greetingEl) {
        const hour = new Date().getHours();
        let greetings;

        if (hour >= 6 && hour < 12) {
            greetings = [
                `<span>${icon}</span> <span>오늘도 빛나는 은혜의 하루 되세요!</span>`,
                `<span>${icon}</span> <span>은혜가 가득한 상쾌한 아침입니다</span>`,
                `<span>${icon}</span> <span>하나님의 사랑과 평강이 함께하시길</span>`,
                `<span>${icon}</span> <span>새 아침, 말씀의 빛으로 걸어가세요</span>`
            ];
        } else if (hour >= 12 && hour < 18) {
            greetings = [
                `<span>${icon}</span> <span>따뜻하고 평안한 오후 시간 되세요</span>`,
                `<span>${icon}</span> <span>오후에도 하나님의 은혜가 듬뿍!</span>`,
                `<span>${icon}</span> <span>잠시 쉬어가며 주 안의 평강을 누리세요</span>`,
                `<span>${icon}</span> <span>주 안에서 기쁨과 감사로 가득한 오후</span>`
            ];
        } else if (hour >= 18) {
            greetings = [
                `<span>${icon}</span> <span>오늘 하루도 정말 수고 많으셨습니다</span>`,
                `<span>${icon}</span> <span>말씀과 함께 깊은 안식을 누리세요</span>`,
                `<span>${icon}</span> <span>평안한 저녁, 은혜의 시간을 품습니다</span>`,
                `<span>${icon}</span> <span>주님의 평강이 온 밤을 지켜주시길</span>`
            ];
        } else {
            greetings = [
                `<span>${icon}</span> <span>조용한 새벽, 말씀으로 하루를 엽니다</span>`,
                `<span>${icon}</span> <span>새벽을 깨우는 귀한 발걸음, 축복합니다</span>`,
                `<span>${icon}</span> <span>하나님과 독대하는 깊은 새벽 되세요</span>`
            ];
        }
        
        greetingEl.innerHTML = greetings[Math.floor(Math.random() * greetings.length)];
    }

    if (verseEl) {
        verseEl.textContent = FAITH_BIBLE_VERSES[Math.floor(Math.random() * FAITH_BIBLE_VERSES.length)];
    }

    // 말씀 변경 버튼 이벤트 등록
    const refreshBtn = document.getElementById('btn-refresh-verse');
    if (refreshBtn && !refreshBtn._bound) {
        refreshBtn._bound = true;
        refreshBtn.onclick = (e) => {
            e.stopPropagation();
            refreshFaithVerseAndBg();
        };
    }
}

/* ==========================================================================
   노트펜 (캔버스 드로잉) 기능
   ========================================================================== */
function enablePenMode() {
    const canvases = document.querySelectorAll('.pen-canvas');
    const editors = document.querySelectorAll('.sermon-editor');
    if (canvases.length === 0 || editors.length === 0) return;

    // 상태 초기화
    state.isDrawingMode = true;
    if (!state.penMode) state.penMode = 'pen';

    // 캔버스 크기를 에디터에 맞춤
    resizePenCanvas();

    canvases.forEach(canvas => {
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'auto';
        canvas.style.touchAction = 'none';
        canvas.style.zIndex = '20';

        canvas.removeEventListener('pointerdown', penStartDraw);
        canvas.removeEventListener('pointermove', penDraw);
        canvas.removeEventListener('pointerup', penStopDraw);
        canvas.removeEventListener('pointercancel', penStopDraw);
        canvas.removeEventListener('pointerleave', penStopDraw);

        canvas.addEventListener('pointerdown', penStartDraw, { passive: false });
        canvas.addEventListener('pointermove', penDraw, { passive: false });
        canvas.addEventListener('pointerup', penStopDraw, { passive: false });
        canvas.addEventListener('pointercancel', penStopDraw, { passive: false });
        canvas.addEventListener('pointerleave', penStopDraw, { passive: false });
    });

    editors.forEach(editor => {
        editor.setAttribute('contenteditable', 'false');
        editor.style.pointerEvents = 'none';
    });

    // 색상 버튼 이벤트
    document.querySelectorAll('.pen-color-btn').forEach(btn => {
        btn.removeEventListener('click', penColorClick);
        btn.addEventListener('click', penColorClick);
    });

    // 굵기 버튼 이벤트
    document.querySelectorAll('.pen-size-btn').forEach(btn => {
        btn.removeEventListener('click', penSizeClick);
        btn.addEventListener('click', penSizeClick);
    });

    const clearBtn = document.getElementById('btn-pen-clear');
    if (clearBtn) {
        clearBtn.removeEventListener('click', penClearClick);
        clearBtn.addEventListener('click', penClearClick);
    }

    // 통합 되돌리기 버튼 이벤트
    const unifiedUndoBtn = document.getElementById('btn-unified-undo');
    if (unifiedUndoBtn) {
        unifiedUndoBtn.removeEventListener('mousedown', handleUnifiedUndo);
        unifiedUndoBtn.addEventListener('mousedown', handleUnifiedUndo);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // 녹음 버튼 이벤트
    const recordBtn = document.getElementById('btn-record-toggle');
    if (recordBtn) {
        recordBtn.addEventListener('click', handleRecordToggle);
    }
    const bannerStopBtn = document.getElementById('btn-stt-stop-banner');
    if (bannerStopBtn) {
        bannerStopBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            stopAllRecordingAndStt();
            showToast && showToast('✅ 실시간 받아쓰기가 완료되었습니다.', 'info');
        });
    }
});

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let speechRecognition = null;
let sttTempSpan = null;

function isMobilePhoneDevice() {
    const ua = navigator.userAgent;
    const isPhoneUA = /Mobi|Android|iPhone|iPod/i.test(ua) && !/iPad|Macintosh|Tablet/i.test(ua);
    const isSmallScreen = window.innerWidth <= 768;
    return isPhoneUA || isSmallScreen;
}

function isMobileDevice() {
    return isMobilePhoneDevice();
}

async function getGeminiApiKey() {
    let apiKey = localStorage.getItem('gemini_api_key');
    if (!apiKey && db) {
        try {
            const doc = await db.collection('users').doc('_ADMIN_CONFIG_').get();
            if (doc.exists && doc.data().gemini_api_key) {
                apiKey = doc.data().gemini_api_key;
                localStorage.setItem('gemini_api_key', apiKey);
            }
        } catch(e) {
            console.warn('API 키 서버 로드 실패:', e);
        }
    }
    return apiKey;
}

async function transcribeAudioWithGemini(audioBlob) {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
        showToast && showToast('Gemini API 키가 설정되지 않아 받아쓰기를 진행할 수 없습니다.', 'warning', 5000);
        return;
    }

    const summaryOverlay = document.getElementById('summary-loading-overlay');
    let originalText = '';
    if (summaryOverlay) {
        const textEl = summaryOverlay.querySelector('div[style*="font-size: 1rem"]');
        if (textEl) {
            originalText = textEl.textContent;
            textEl.textContent = 'AI가 녹음 음성을 텍스트로 변환 중입니다...';
        }
        summaryOverlay.style.display = 'flex';
    }

    const reader = new FileReader();
    reader.readAsDataURL(audioBlob);
    reader.onloadend = async () => {
        try {
            const base64Data = reader.result.split(',')[1];
            const mimeType = audioBlob.type || 'audio/webm';
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey.trim()}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            {
                                inlineData: {
                                    mimeType: mimeType,
                                    data: base64Data
                                }
                            },
                            {
                                text: "이 녹음 파일의 음성을 한국어로 모두 정확히 받아쓰기(transcribe)해줘. 다른 설명이나 해석은 일절 배제하고 오직 받아쓰기한 결과 텍스트만 그대로 반환해줘."
                            }
                        ]
                    }]
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error("Gemini API Error Detail:", errText);
                throw new Error('Gemini API 전송 실패 (' + response.status + ') 상세: ' + errText.substring(0, 50));
            }

            const data = await response.json();
            let transcribedText = '';
            if (data.candidates && data.candidates[0] && data.candidates[0].content) {
                transcribedText = data.candidates[0].content.parts.map(p => p.text).join('\n').trim();
            }

            if (transcribedText) {
                sttCommitFinal(transcribedText + ' ');
                showToast && showToast('🎉 AI 받아쓰기가 완료되었습니다!', 'info');
            } else {
                showToast && showToast('음성 인식 결과를 추출하지 못했습니다.', 'warning');
            }
        } catch (err) {
            console.error('AI Transcription Error:', err);
            showToast && showToast('AI 받아쓰기 중 오류: ' + err.message, 'error', 5000);
        } finally {
            if (summaryOverlay) {
                summaryOverlay.style.display = 'none';
                const textEl = summaryOverlay.querySelector('div[style*="font-size: 1rem"]');
                if (textEl) textEl.textContent = originalText;
            }
        }
    };
}

function getSttEditor() {
    let editor = window._lastActiveEditor;
    if (!editor || !document.body.contains(editor)) {
        editor = document.querySelector('.sermon-editor');
    }
    return editor;
}

let sttActive = false;
let sttRestartTimer = null;
let sttPendingInterim = '';

function updateSttBanner(text) {
    const banner = document.getElementById('stt-live-banner');
    const textEl = document.getElementById('stt-live-text');
    if (banner && textEl) {
        banner.style.display = 'flex';
        textEl.textContent = text;
    }
}

function hideSttBanner() {
    const banner = document.getElementById('stt-live-banner');
    if (banner) banner.style.display = 'none';
}

function sttCommitFinal(text) {
    if (!text || !text.trim()) return;
    const editor = getSttEditor();
    if (!editor) return;

    editor.focus();

    // 이전에 저장된 커서 위치 복원
    if (savedSelectionRange) {
        try {
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(savedSelectionRange);
        } catch(e) {}
    }

    const cleanText = text.endsWith(' ') ? text : (text + ' ');
    let inserted = false;
    try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
            inserted = document.execCommand('insertText', false, cleanText);
        }
    } catch(e) {
        inserted = false;
    }

    if (!inserted) {
        try {
            const textNode = document.createTextNode(cleanText);
            editor.appendChild(textNode);
            const sel = window.getSelection();
            if (sel) {
                const range = document.createRange();
                range.setStartAfter(textNode);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        } catch(e) {}
    }

    // 커서 위치 갱신 및 에디터 스크롤 동기화
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        try {
            savedSelectionRange = sel.getRangeAt(0).cloneRange();
        } catch(e) {}
        
        try {
            const r = sel.getRangeAt(0);
            const rect = r.getBoundingClientRect();
            const editorArea = document.querySelector('.editor-area');
            if (editorArea && rect && rect.bottom > 0) {
                const vvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
                if (rect.bottom > vvHeight - 100) {
                    editorArea.scrollTop += (rect.bottom - (vvHeight - 100));
                }
            }
        } catch(e) {}
    }

    if (typeof recordEditorTextState === 'function') {
        recordEditorTextState(editor);
    }

    autoSave();
}

function stopSpeechRecognition() {
    stopAllRecordingAndStt();
}

function stopAllRecordingAndStt() {
    isRecording = false;
    sttActive = false;

    if (sttRestartTimer) {
        clearTimeout(sttRestartTimer);
        sttRestartTimer = null;
    }

    // 미완료된 받아쓰기 내용이 있다면 최종 커밋
    if (sttPendingInterim) {
        sttCommitFinal(sttPendingInterim);
        sttPendingInterim = '';
    }

    if (speechRecognition) {
        try { speechRecognition.abort(); } catch(e) {}
        speechRecognition = null;
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch(e) {}
        mediaRecorder = null;
    }

    hideSttBanner();

    const btn = document.getElementById('btn-record-toggle');
    if (btn) {
        btn.style.color = '';
        btn.querySelector('i').className = 'fas fa-microphone';
        btn.querySelector('span').textContent = '녹음';
    }

    const tempSpan = document.getElementById('stt-interim-span');
    if (tempSpan) tempSpan.remove();
    sttTempSpan = null;

    autoSave();
    if (typeof saveToStorage === 'function') saveToStorage();
    if (typeof debouncedSyncToFirestore === 'function') debouncedSyncToFirestore();
}

function startContinuousStt() {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
        showToast && showToast('이 브라우저는 실시간 받아쓰기를 지원하지 않습니다. Chrome 또는 Samsung Internet 브라우저를 사용해주세요.', 'warning', 5000);
        return;
    }

    // 하단 서식 패널 모두 접기
    if (typeof collapseAllSubPanels === 'function') collapseAllSubPanels();
    const textFormatPanel = document.getElementById('text-format-panel');
    const btnTextToggle = document.getElementById('btn-text-toggle');
    const notepenFormatPanel = document.getElementById('notepen-format-panel');
    const btnNotepenToggle = document.getElementById('btn-notepen-toggle');
    const panelPageStyle = document.getElementById('page-style-panel');
    const btnPageStyle = document.getElementById('btn-page-style');
    if (textFormatPanel) textFormatPanel.style.display = 'none';
    if (btnTextToggle) btnTextToggle.classList.remove('active');
    if (notepenFormatPanel) notepenFormatPanel.style.display = 'none';
    if (btnNotepenToggle) btnNotepenToggle.classList.remove('active');
    if (panelPageStyle) panelPageStyle.style.display = 'none';
    if (btnPageStyle) btnPageStyle.classList.remove('active');
    if (typeof disableAllPenModes === 'function') disableAllPenModes();

    isRecording = true;
    sttActive = true;
    sttPendingInterim = '';

    const btn = document.getElementById('btn-record-toggle');
    if (btn) {
        btn.style.color = '#ef4444';
        btn.querySelector('i').className = 'fas fa-stop-circle';
        btn.querySelector('span').textContent = '중지';
    }

    updateSttBanner('🎙️ 실시간 받아쓰기 중... 말씀하세요');

    const editor = getSttEditor();
    if (editor) editor.focus();

    runSttLoop(SpeechRecognitionClass);
    showToast && showToast('✍️ 실시간 받아쓰기가 시작되었습니다.', 'info');
}

function runSttLoop(SpeechRecognitionClass) {
    if (!sttActive) return;

    if (speechRecognition) {
        try { speechRecognition.abort(); } catch(e) {}
        speechRecognition = null;
    }

    try {
        const rec = new SpeechRecognitionClass();
        rec.lang = 'ko-KR';
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        let sessionLastFinalIdx = -1;

        rec.onstart = () => {
            console.log('🎙️ STT 세션 시작');
            updateSttBanner('🎙️ 실시간 받아쓰기 중... 말씀하세요');
        };

        rec.onresult = (event) => {
            let interim = '';
            for (let i = 0; i < event.results.length; ++i) {
                const res = event.results[i];
                if (res.isFinal) {
                    if (i > sessionLastFinalIdx) {
                        sessionLastFinalIdx = i;
                        const finalTxt = res[0].transcript.trim();
                        if (finalTxt) {
                            sttCommitFinal(finalTxt);
                            sttPendingInterim = '';
                        }
                    }
                } else {
                    interim += res[0].transcript;
                }
            }

            if (interim) {
                sttPendingInterim = interim.trim();
                updateSttBanner('🎙️ ' + sttPendingInterim);
            } else {
                updateSttBanner('🎙️ 실시간 받아쓰기 중... 말씀하세요');
            }
        };

        rec.onerror = (event) => {
            console.log('STT 상태:', event.error);
            if (event.error === 'aborted' || event.error === 'no-speech') {
                return;
            }
            if (event.error === 'not-allowed') {
                showToast && showToast('마이크 사용 권한이 거부되었습니다. 브라우저 설정에서 마이크를 허용해주세요.', 'warning', 4000);
                stopAllRecordingAndStt();
            } else if (event.error === 'audio-capture') {
                console.warn('마이크 일시적 점유 지연, 재연결 시도');
            }
        };

        rec.onend = () => {
            console.log('STT 세션 종료, sttActive:', sttActive);
            if (sttActive) {
                if (sttPendingInterim) {
                    sttCommitFinal(sttPendingInterim);
                    sttPendingInterim = '';
                }
                if (sttRestartTimer) clearTimeout(sttRestartTimer);
                sttRestartTimer = setTimeout(() => {
                    if (sttActive) {
                        runSttLoop(SpeechRecognitionClass);
                    }
                }, 150);
            }
        };

        speechRecognition = rec;
        rec.start();
    } catch(err) {
        console.warn('STT run error:', err);
        if (sttActive) {
            if (sttRestartTimer) clearTimeout(sttRestartTimer);
            sttRestartTimer = setTimeout(() => {
                if (sttActive) runSttLoop(SpeechRecognitionClass);
            }, 300);
        }
    }
}

function initSpeechRecognition(SpeechRecognitionClass) {
    return runSttLoop(SpeechRecognitionClass);
}

function showMobileRecordChoiceModal() {
    const modal = document.getElementById('mobile-record-choice-modal');
    if (!modal) return;
    modal.classList.add('active');

    const btnRecOnly = document.getElementById('btn-mobile-rec-only');
    const btnSttOnly = document.getElementById('btn-mobile-stt-only');
    const btnCancel = document.getElementById('btn-mobile-rec-cancel');

    if (btnRecOnly) {
        btnRecOnly.onclick = () => {
            modal.classList.remove('active');
            startMobileRecordOnly();
        };
    }

    if (btnSttOnly) {
        btnSttOnly.onclick = () => {
            modal.classList.remove('active');
            startContinuousStt();
        };
    }

    if (btnCancel) {
        btnCancel.onclick = () => {
            modal.classList.remove('active');
        };
    }
}

function startMobileRecordOnly() {
    // 하단 서식 패널 모두 접기
    if (typeof collapseAllSubPanels === 'function') collapseAllSubPanels();
    const btn = document.getElementById('btn-record-toggle');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                isRecording = true;
                if (btn) {
                    btn.style.color = '#ef4444';
                    btn.querySelector('i').className = 'fas fa-stop-circle';
                    btn.querySelector('span').textContent = '중지';
                }
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];
                mediaRecorder.addEventListener('dataavailable', e => {
                    if (e.data && e.data.size > 0) audioChunks.push(e.data);
                });
                mediaRecorder.addEventListener('stop', () => {
                    handleMediaRecorderStop(stream);
                });
                mediaRecorder.start();
                showToast && showToast('🎙️ 음성 녹음이 시작되었습니다. (기기 보관)', 'info');
            })
            .catch(err => {
                console.error('Mobile mic error:', err);
                showToast && showToast('마이크 접근에 실패했습니다: ' + err.message, 'error');
                resetRecordButton();
            });
    } else {
        showToast && showToast('이 기기/브라우저는 녹음을 지원하지 않습니다.', 'error');
    }
}

function startMobileSttOnly() {
    startContinuousStt();
}

function handleRecordToggle() {
    if (isRecording) {
        stopAllRecordingAndStt();
        showToast && showToast('✅ 녹음/받아쓰기가 완료되었습니다.', 'info');
        return;
    }

    // 하단부 모든 펼침 서식 패널 즉시 접기
    if (typeof collapseAllSubPanels === 'function') collapseAllSubPanels();
    const textFormatPanel = document.getElementById('text-format-panel');
    const btnTextToggle = document.getElementById('btn-text-toggle');
    const notepenFormatPanel = document.getElementById('notepen-format-panel');
    const btnNotepenToggle = document.getElementById('btn-notepen-toggle');
    const panelPageStyle = document.getElementById('page-style-panel');
    const btnPageStyle = document.getElementById('btn-page-style');
    if (textFormatPanel) textFormatPanel.style.display = 'none';
    if (btnTextToggle) btnTextToggle.classList.remove('active');
    if (notepenFormatPanel) notepenFormatPanel.style.display = 'none';
    if (btnNotepenToggle) btnNotepenToggle.classList.remove('active');
    if (panelPageStyle) panelPageStyle.style.display = 'none';
    if (btnPageStyle) btnPageStyle.classList.remove('active');
    if (typeof disableAllPenModes === 'function') disableAllPenModes();

    showMobileRecordChoiceModal();
}

function handleMediaRecorderStop(stream) {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks = [];
    stream.getTracks().forEach(t => t.stop());

    if (audioBlob.size === 0) return;

    const dateStr = new Date().toLocaleDateString('ko-KR');
    let defaultTitle = '녹음 파일';
    if (state.currentNoteId && state.notes[state.currentNoteId]) {
        const note = state.notes[state.currentNoteId];
        if (note.pages && note.pages[0] && note.pages[0].content) {
            const tmp = document.createElement('div');
            tmp.innerHTML = note.pages[0].content;
            const h1 = tmp.querySelector('h1,h2,h3');
            if (h1 && h1.innerText.trim()) defaultTitle = h1.innerText.trim();
        }
    }

    const title = prompt('녹음 파일의 제목을 입력하세요:', defaultTitle);
    if (title === null) return;
    const finalTitle = title.trim() || defaultTitle;
    const id = 'rec_' + Date.now();

    RecordDB.save(id, finalTitle, dateStr, audioBlob, state.currentNoteId)
        .then(() => {
            if (state.currentNoteId && state.notes[state.currentNoteId]) {
                state.notes[state.currentNoteId].hasRecording = true;
                saveToStorage();
                renderWorshipTypes();
            }
            showToast && showToast('녹음이 기기에 저장되었습니다.', 'info');
            typeof renderRecordList === 'function' && renderRecordList();
        })
        .catch(e => {
            console.error('RecordDB save error:', e);
            showToast && showToast('녹음 저장 실패: ' + (e.message || e), 'error', 5000);
        });
}

function resetRecordButton() {
    isRecording = false;
    const btn = document.getElementById('btn-record-toggle');
    if (btn) {
        btn.style.color = '';
        btn.querySelector('i').className = 'fas fa-microphone';
        btn.querySelector('span').textContent = '녹음';
    }
}

// 글자쓰기 모드 텍스트 되돌리기(Undo) 스택 관리
const editorTextUndoStack = [];
let isUndoOperating = false;

function recordEditorTextState(editor) {
    if (!editor || isUndoOperating) return;
    const content = editor.innerHTML;
    if (editorTextUndoStack.length > 0 && editorTextUndoStack[editorTextUndoStack.length - 1] === content) {
        return;
    }
    editorTextUndoStack.push(content);
    if (editorTextUndoStack.length > 50) {
        editorTextUndoStack.shift();
    }
}

function handleUnifiedUndo(e) {
    if (e && e.preventDefault) e.preventDefault(); // 포커스 잃지 않도록
    
    if (state.isDrawingMode) {
        penUndoClick(e);
        return;
    }

    // 글자쓰기 모드 되돌리기
    const editor = getSttEditor();
    if (!editor) return;

    editor.focus();

    // 1차: 브라우저 기본 undo 명령 시도
    let nativeSuccess = false;
    try {
        nativeSuccess = document.execCommand('undo', false, null);
    } catch(err) {
        nativeSuccess = false;
    }

    // 2차: 브라우저 undo로 내용 변화가 없거나 실패 시 커스텀 텍스트 undo 스택 복원
    if (editorTextUndoStack.length > 1) {
        isUndoOperating = true;
        try {
            editorTextUndoStack.pop();
            const prevState = editorTextUndoStack[editorTextUndoStack.length - 1];
            if (prevState !== undefined) {
                editor.innerHTML = prevState;
                // 커서를 끝으로 이동
                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(editor);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
                savedSelectionRange = range.cloneRange();
                autoSave();
                showToast && showToast('글자 되돌리기 완료', 'info', 1500);
            }
        } catch(err) {
            console.warn('Custom text undo error:', err);
        } finally {
            isUndoOperating = false;
        }
    } else {
        autoSave();
    }
}

function disablePenMode() {
    state.isDrawingMode = false;
    drawingCtx = null;
    isDrawing = false;

    document.querySelectorAll('.pen-canvas').forEach(canvas => {
        canvas.style.pointerEvents = 'none';
        canvas.style.touchAction = 'auto';
        canvas.removeEventListener('pointerdown', penStartDraw);
        canvas.removeEventListener('pointermove', penDraw);
        canvas.removeEventListener('pointerup', penStopDraw);
        canvas.removeEventListener('pointercancel', penStopDraw);
        canvas.removeEventListener('pointerleave', penStopDraw);
    });

    document.querySelectorAll('.sermon-editor').forEach(editor => {
        editor.setAttribute('contenteditable', 'true');
        editor.style.pointerEvents = 'auto';
    });

    saveDrawingToNote();
}

function penUndoClick(e) {
    if (e) e.stopPropagation();
    if (drawingUndoStack.length === 0) return;

    const previousState = drawingUndoStack.pop();
    const canvas = previousState.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const img = new Image();
    img.onload = () => {
        if (img.width <= 0 || img.height <= 0) return;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        try {
            ctx.drawImage(img, 0, 0);
        } catch(e) {
            console.warn('penUndoClick drawImage error:', e);
        }
        ctx.restore();
        saveDrawingToNote();
    };
    img.src = previousState.data;
}

function penClearClick(e) {
    if (e) e.stopPropagation();
    if (!confirm('캔버스의 모든 그림을 지우시겠습니까?')) return;

    document.querySelectorAll('.pen-canvas').forEach(canvas => {
        // 지우기 전 상태 저장
        drawingUndoStack.push({ canvas: canvas, data: canvas.toDataURL() });
        if (drawingUndoStack.length > 30) drawingUndoStack.shift();

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    });
    saveDrawingToNote();
    if (typeof window.closeNotepenFormatPanel === 'function') window.closeNotepenFormatPanel();
}

let canvasResizeObserver = null;
let lastStylusTime = 0;
let activePointerId = null;

function updateOffscreenBuffer(canvas) {
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
    if (!canvas._offscreenCanvas) {
        canvas._offscreenCanvas = document.createElement('canvas');
    }
    const offscreen = canvas._offscreenCanvas;
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    const offCtx = offscreen.getContext('2d');
    offCtx.clearRect(0, 0, offscreen.width, offscreen.height);
    try {
        offCtx.drawImage(canvas, 0, 0);
    } catch(e) {
        console.warn('updateOffscreenBuffer drawImage error:', e);
    }
}

function resizePenCanvas() {
    document.querySelectorAll('.pen-canvas').forEach(canvas => {
        const wrapper = canvas.closest('.a4-page-wrapper');
        if (!wrapper) return;

        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.top = '0';
        canvas.style.left = '0';

        const dpr = window.devicePixelRatio || 1;
        const width = wrapper.offsetWidth;
        const height = wrapper.offsetHeight;
        const physWidth = Math.floor(width * dpr);
        const physHeight = Math.floor(height * dpr);

        if (physWidth <= 0 || physHeight <= 0) return;

        if (canvas.width !== physWidth || canvas.height !== physHeight) {
            if (!canvas._offscreenCanvas && canvas.width > 1 && canvas.height > 1) {
                updateOffscreenBuffer(canvas);
            }
            const offscreen = canvas._offscreenCanvas;

            canvas.width = physWidth;
            canvas.height = physHeight;

            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            if (offscreen && offscreen.width > 0 && offscreen.height > 0) {
                // 이전 그림을 1:1 원본 비율(늘리지 않고)로 (0, 0) 위치에 그대로 그리기
                ctx.drawImage(offscreen, 0, 0);
            }
            ctx.restore();

            updateOffscreenBuffer(canvas);
        }
    });
}

function initCanvasResizeObserver() {
    if (!window.ResizeObserver) return;
    if (canvasResizeObserver) canvasResizeObserver.disconnect();

    canvasResizeObserver = new ResizeObserver(() => {
        resizePenCanvas();
    });

    document.querySelectorAll('.a4-page-wrapper').forEach(wrapper => {
        canvasResizeObserver.observe(wrapper);
    });
}

function setPenDrawingStyle() {
    if (!drawingCtx) return;
    drawingCtx.lineCap = 'round';
    drawingCtx.lineJoin = 'round';

    if (state.isEraser) {
        drawingCtx.globalCompositeOperation = 'destination-out';
        drawingCtx.lineWidth = state.eraserWidth || 25;
        drawingCtx.strokeStyle = 'rgba(0,0,0,1)';
        drawingCtx.globalAlpha = 1;
    } else {
        if (!state.penSettings) {
            state.penSettings = {
                pen: { color: '#1e293b', width: 2 },
                highlighter: { color: 'rgba(254, 240, 138, 0.4)', width: 16 }
            };
        }
        const mode = state.penMode || 'pen';
        drawingCtx.globalCompositeOperation = 'source-over';
        drawingCtx.globalAlpha = 1;

        if (mode === 'highlighter') {
            // 형광펜: 한 획 내에서 색이 중첩 쌓이지 않도록 globalAlpha 분리
            // strokeStyle을 불투명하게, globalAlpha로 투명도 조절
            drawingCtx.globalAlpha = 0.35;
            const baseColor = (state.penSettings.highlighter.color || 'rgba(254, 240, 138, 0.4)');
            // rgba에서 rgb만 추출
            const m = baseColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            drawingCtx.strokeStyle = m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : 'rgb(254, 240, 138)';
            drawingCtx.lineWidth = state.penSettings.highlighter.width || 16;
            drawingCtx.lineCap = 'square';
            drawingCtx.lineJoin = 'bevel';
        } else {
            drawingCtx.strokeStyle = state.penSettings[mode].color;
            drawingCtx.lineWidth = state.penSettings[mode].width;
        }
    }
}

function getPenCoords(e, canvas) {
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    let clientX = e.clientX; let clientY = e.clientY;
    if (e.touches && e.touches.length > 0) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
    else if (e.changedTouches && e.changedTouches.length > 0) { clientX = e.changedTouches[0].clientX; clientY = e.changedTouches[0].clientY; }
    const dpr = window.devicePixelRatio || 1;
    const scaleX = canvas.width / rect.width / dpr;
    const scaleY = canvas.height / rect.height / dpr;
    return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
}

function isPalmOrFingerRejected(e) {
    const now = Date.now();
    
    // S-Pen / Apple Pencil / Stylus 판별
    const isStylus = (e.pointerType === 'pen' || e.pointerType === 'stylus' || (e.touchType && e.touchType === 'stylus'));
    
    if (isStylus) {
        lastStylusTime = now;
        return false; // 펜 입력은 항상 통과
    }
    
    // 펜 사용 후 5초 이내에 발생하는 손가락/손바닥 터치는 100% 거부 (Palm Rejection)
    if (now - lastStylusTime < 5000) {
        return true;
    }
    
    // 펜을 안 쓸 때도 닿는 면적이 넓은 손바닥 터치 거부 (contact area > 28px)
    if (e.pointerType === 'touch' || (e.touches && e.touches.length > 0)) {
        if ((e.width && e.width > 28) || (e.height && e.height > 28)) {
            return true;
        }
    }

    return false;
}

function penStartDraw(e) {
    if (!state.isDrawingMode) return;

    // 손바닥/손가락 터치 거부 검사 (Palm Rejection)
    if (isPalmOrFingerRejected(e)) {
        if (e.cancelable) e.preventDefault();
        return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (e.pointerId !== undefined) {
        activePointerId = e.pointerId;
    }

    isDrawing = true;

    // 현재 그리기 대상 캔버스를 이벤트 발생 캔버스로 설정
    const canvas = e.currentTarget;
    drawingCtx = canvas.getContext('2d', { willReadFrequently: true });

    // DPR 스케일 적용
    const dpr = window.devicePixelRatio || 1;
    drawingCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Undo 스택에 현재 상태 저장
    drawingUndoStack.push({ canvas: canvas, data: canvas.toDataURL() });
    if (drawingUndoStack.length > 30) drawingUndoStack.shift();

    setPenDrawingStyle();
    const [x, y] = getPenCoords(e, canvas);
    lastX = x;
    lastY = y;

    if (!state.isEraser && state.penMode !== 'highlighter') {
        drawingCtx.beginPath();
        drawingCtx.arc(x, y, Math.max(drawingCtx.lineWidth / 2, 1), 0, Math.PI * 2);
        drawingCtx.fillStyle = (state.penSettings && state.penSettings.pen) ? state.penSettings.pen.color : '#1e293b';
        drawingCtx.fill();
    }
    drawingCtx.beginPath();
    drawingCtx.moveTo(x, y);
}

function penDraw(e) {
    if (!isDrawing || !state.isDrawingMode || !drawingCtx) return;

    // 현재 스트로크를 시작한 포인터만 처리 (다중 터치 간섭 방지)
    if (e.pointerId !== undefined && activePointerId !== null && e.pointerId !== activePointerId) {
        return;
    }

    if (isPalmOrFingerRejected(e)) return;

    e.preventDefault();
    e.stopPropagation();
    const canvas = e.currentTarget;
    const [x, y] = getPenCoords(e, canvas);

    if (state.penMode === 'highlighter') {
        drawingCtx.lineTo(x, y);
    } else {
        setPenDrawingStyle();
        drawingCtx.lineTo(x, y);
        drawingCtx.stroke();
        drawingCtx.beginPath();
        drawingCtx.moveTo(x, y);
    }
    lastX = x;
    lastY = y;
}

function penStopDraw(e) {
    if (!isDrawing) return;

    if (e && e.pointerId !== undefined && activePointerId !== null && e.pointerId !== activePointerId) {
        return;
    }

    if (drawingCtx && state.penMode === 'highlighter') {
        setPenDrawingStyle();
        drawingCtx.stroke();
        drawingCtx.globalAlpha = 1;
    }

    if (drawingCtx) drawingCtx.beginPath();
    isDrawing = false;
    activePointerId = null;

    if (e && e.currentTarget) {
        updateOffscreenBuffer(e.currentTarget);
    } else {
        document.querySelectorAll('.pen-canvas').forEach(c => updateOffscreenBuffer(c));
    }
    saveDrawingToNote();
}

function penColorClick(e) {
    e.stopPropagation();
    const color = e.currentTarget.dataset.color;
    const mode = e.currentTarget.dataset.mode || 'pen';
    if (!color) return;
    
    state.penMode = mode;
    if (!state.penSettings) {
        state.penSettings = {
            pen: { color: '#1e293b', width: 2 },
            highlighter: { color: 'rgba(254, 240, 138, 0.4)', width: 16 }
        };
    }
    state.penSettings[mode].color = color;
    
    if (state.isEraser) {
        state.isEraser = false;
        const btnPenEraser = document.getElementById('btn-pen-eraser');
        if (btnPenEraser) btnPenEraser.classList.remove('active');
    }

    document.querySelectorAll(`.pen-color-btn[data-mode="${mode}"]`).forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    
    setPenDrawingStyle();

    // 선택 시 노트펜 서식 패널 즉시 접기
    if (typeof window.closeNotepenFormatPanel === 'function') window.closeNotepenFormatPanel();
}

function penSizeClick(e) {
    e.stopPropagation();
    const size = parseInt(e.currentTarget.dataset.size);
    const mode = e.currentTarget.dataset.mode || 'pen';
    if (size) {
        if (mode === 'eraser') {
            state.eraserWidth = size;
        } else {
            if (!state.penSettings) {
                state.penSettings = {
                    pen: { color: '#1e293b', width: 2 },
                    highlighter: { color: 'rgba(254, 240, 138, 0.4)', width: 16 }
                };
            }
            state.penSettings[mode].width = size;
        }
    }

    document.querySelectorAll(`.pen-size-btn[data-mode="${mode}"]`).forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    
    setPenDrawingStyle();

    // 선택 시 노트펜 서식 패널 즉시 접기
    if (typeof window.closeNotepenFormatPanel === 'function') window.closeNotepenFormatPanel();
}

function saveDrawingToNote() {
    saveAllPages();
    saveToStorage();
    debouncedSyncToFirestore();
}

function loadDrawingForCanvas(canvas, editor, drawingData) {
    if (!canvas) return;
    const wrapper = canvas.closest('.a4-page-wrapper');
    const dpr = window.devicePixelRatio || 1;
    const width = wrapper ? wrapper.offsetWidth : (editor ? editor.offsetWidth : 600);
    const height = wrapper ? wrapper.offsetHeight : (editor ? editor.offsetHeight : 800);

    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (drawingData) {
        canvas.style.display = 'block';
        const img = new Image();
        img.onload = () => {
            if (img.width <= 0 || img.height <= 0) return;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            try {
                ctx.drawImage(img, 0, 0);
            } catch(e) {
                console.warn('loadDrawingForCanvas drawImage error:', e);
            }
            ctx.restore();
            updateOffscreenBuffer(canvas);
        };
        img.src = drawingData;
    } else {
        updateOffscreenBuffer(canvas);
    }

    initCanvasResizeObserver();
}
function loadDrawingForNote(note) {}

/* ==========================================================================
   Page Navigator Logic
   ========================================================================== */
function updatePageNavigator() { /* 단일 페이지 모드 - 불필요 */ }

function goToPage(index) { /* 단일 페이지 모드 - 불필요 */ }

function addNewPage() { /* 단일 페이지 모드 - 불필요 */ }

function deleteCurrentPage() { /* 단일 페이지 모드 - 불필요 */ }

    // (페이지 네비게이터 이벤트 제거 - 단일 페이지 모드)
    // Hide custom splash screen
    const splashScreen = document.getElementById('app-splash-screen');
    if (splashScreen) {
        setTimeout(() => {
            splashScreen.style.opacity = '0';
            splashScreen.style.visibility = 'hidden';
            setTimeout(() => { splashScreen.style.display = 'none'; }, 800); // Remove from layout after fade out
        }, 1500);
    }

    // Global drag selection & click-to-edit management
    let isMouseDown = false;
    let startX = 0;
    let startY = 0;
    let isDragging = false;

    document.addEventListener('mousedown', (e) => {
        const editor = e.target.closest('.sermon-editor');
        if (!editor || state.isDrawingMode) return;
        isMouseDown = true;
        startX = e.clientX;
        startY = e.clientY;
        isDragging = false;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isMouseDown || isDragging) return;
        const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (dist > 5) {
            isDragging = true;
            // Disable contenteditable on all editors so user can select text across pages natively
            document.querySelectorAll('.sermon-editor').forEach(el => {
                el.setAttribute('contenteditable', 'false');
            });
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (!isMouseDown) return;
        isMouseDown = false;

        if (!isDragging) {
            if (!state.isDrawingMode) {
                document.querySelectorAll('.sermon-editor').forEach(el => {
                    el.setAttribute('contenteditable', 'true');
                });
            }
        }
    });

    // Touch support for mobile text selection across pages
    let isTouchDown = false;
    let startTouchX = 0;
    let startTouchY = 0;
    let isTouchDragging = false;

    // 모바일 contenteditable 복원 함수
    function restoreEditability() {
        if (!state.isDrawingMode) {
            document.querySelectorAll('.sermon-editor').forEach(el => {
                el.setAttribute('contenteditable', 'true');
            });
        }
    }

    document.addEventListener('touchstart', (e) => {
        const editor = e.target.closest('.sermon-editor');
        if (!editor || state.isDrawingMode) return;
        isTouchDown = true;
        const touch = e.touches[0];
        startTouchX = touch.clientX;
        startTouchY = touch.clientY;
        isTouchDragging = false;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!isTouchDown || isTouchDragging) return;
        const touch = e.touches[0];
        const dist = Math.hypot(touch.clientX - startTouchX, touch.clientY - startTouchY);
        // 임계값을 40px로 높여 스크롤/키보드 진동에 의한 오작동 방지
        if (dist > 40) {
            isTouchDragging = true;
            document.querySelectorAll('.sermon-editor').forEach(el => {
                el.setAttribute('contenteditable', 'false');
            });
        }
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        if (!isTouchDown) return;
        isTouchDown = false;

        // drag 여부와 관계없이 항상 contenteditable 복원
        // (drag 중 비활성화된 경우에도 touchend에서 반드시 복원)
        restoreEditability();

        isTouchDragging = false;
    });

    // touchcancel (전화 수신 등 중단)에서도 반드시 복원
    document.addEventListener('touchcancel', () => {
        isTouchDown = false;
        isTouchDragging = false;
        restoreEditability();
    });

    // Handle Ctrl+A / Cmd+A to select all text across all pages
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            const activeEl = document.activeElement;
            if (activeEl && activeEl.classList.contains('sermon-editor')) {
                e.preventDefault();
                const editors = document.querySelectorAll('.sermon-editor');
                if (editors.length > 0) {
                    editors.forEach(el => el.setAttribute('contenteditable', 'false'));
                    const range = document.createRange();
                    const firstEditor = editors[0];
                    const lastEditor = editors[editors.length - 1];
                    range.setStart(firstEditor, 0);
                    range.setEnd(lastEditor, lastEditor.childNodes.length || lastEditor.textContent.length);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
        }
    });


function renderAllPages(note) {
    const wrap = document.querySelector('#editor-area-wrap');
    if (!wrap) return;

    // 기존 페이지 래퍼 제거
    wrap.querySelectorAll('.a4-page-wrapper').forEach(el => el.remove());

    // 기존 다중 페이지 데이터를 하나로 합치기 (하위 호환성)
    if (!note.pages || !Array.isArray(note.pages)) {
        note.pages = [];
    }
    note.pages = note.pages.filter(p => p !== null && p !== undefined);

    if (note.pages.length === 0) {
        note.pages = [{ content: note.content || '', drawingData: null }];
    }
    // 여러 페이지가 있으면 내용을 합쳐 단일 페이지로
    if (note.pages.length > 1) {
        const combined = note.pages.map(p => (p && p.content) || '').join('');
        note.pages = [{ content: combined, drawingData: null }];
    }

    const page = note.pages[0] || { content: '', drawingData: null };

    const pageEl = document.createElement('div');
    pageEl.className = 'a4-page-wrapper';
    if (wrap.classList.contains('horizontal-mode')) pageEl.classList.add('horizontal-mode');
    pageEl.dataset.index = 0;

    const editor = document.createElement('div');
    editor.className = 'sermon-editor';
    if (wrap.classList.contains('horizontal-mode')) editor.classList.add('horizontal-mode');
    editor.setAttribute('contenteditable', state.isDrawingMode ? 'false' : 'true');
    editor.setAttribute('placeholder', '자동에서 성경 약어 즉 막 1 1 혹은 막 1:1을 입력 후 스페이스바/엔터를 치면 성경구절이 입력창에 바로 구현됩니다. 수동에서는 성경구절 창에 성경구절이 구현됩니다.');
    editor.innerHTML = page.content || '';
    editor.style.fontSize = state.fontSize + 'px';

    if (editor.innerText.trim() === '') editor.classList.add('show-placeholder');

    // --- 이벤트 리스너 ---
    editor.addEventListener('input', handleEditorInput);

    // 성경구절 span 내부에서 엔터 처리
    editor.addEventListener('keydown', function fixBibleVerseEnter(e) {
        if (e.key !== 'Enter') return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);

        let bibleSpan = null;
        let node = range.startContainer;

        let cur = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
        while (cur && cur !== editor) {
            if (cur.classList && cur.classList.contains('bible-verse-inline')) {
                bibleSpan = cur;
                break;
            }
            cur = cur.parentNode;
        }

        if (!bibleSpan && node.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
            let prev = node.previousSibling;
            if (prev && prev.classList && prev.classList.contains('bible-verse-inline')) {
                bibleSpan = prev;
            }
        }

        if (!bibleSpan && node.nodeType === Node.TEXT_NODE) {
            let textBefore = node.textContent.substring(0, range.startOffset);
            if (textBefore.replace(/\u200B/g, '').length === 0) {
                let prev = node.previousSibling;
                if (prev && prev.classList && prev.classList.contains('bible-verse-inline')) {
                    bibleSpan = prev;
                }
            }
        }

        if (bibleSpan) {
            e.preventDefault();
            let prevFont = null;
            let prevNode = bibleSpan.previousSibling;
            while (prevNode) {
                if (prevNode.nodeType === Node.ELEMENT_NODE) {
                    prevFont = window.getComputedStyle(prevNode).fontFamily;
                    break;
                } else if (prevNode.nodeType === Node.TEXT_NODE && prevNode.textContent.trim().length > 0) {
                    prevFont = window.getComputedStyle(prevNode.parentNode).fontFamily;
                    break;
                }
                prevNode = prevNode.previousSibling;
            }
            if (!prevFont) {
                prevFont = state.fontFamily || window.getComputedStyle(editor).fontFamily || "'Malgun Gothic', '맑은 고딕', sans-serif";
            }
            const newRange = document.createRange();
            newRange.setStartAfter(bibleSpan);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            document.execCommand('insertParagraph', false);
            document.execCommand('styleWithCSS', false, true);
            document.execCommand('fontName', false, prevFont);
            autoSave();
        }
    });

    // 한글 IME 조합 상태 추적
    let isComposing = false;
    editor.addEventListener('compositionstart', () => { isComposing = true; });
    editor.addEventListener('compositionend', () => { isComposing = false; });

    editor.addEventListener('input', (e) => {
        triggerTypingMode();
        autoSave();

        if (editor.textContent.trim() === '') editor.classList.add('show-placeholder');
        else editor.classList.remove('show-placeholder');

        const isDeleting = e.inputType && e.inputType.startsWith('delete');
        const isComposingNow = isComposing || e.isComposing;
        const isTriggerChar = e.data === ' ' || e.data === '\n' || !e.data || e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph';

        if (isTriggerChar && !isDeleting && !isComposingNow && state.autoInsert) {
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                let node = range.startContainer;
                let offset = range.startOffset;
                let textBefore = '';
                if (node.nodeType === Node.TEXT_NODE) {
                    textBefore = node.textContent.substring(0, offset);
                }
                if (textBefore.trim() === '' && (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph' || !e.data)) {
                    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null, false);
                    walker.currentNode = node;
                    const prevNode = walker.previousNode();
                    if (prevNode) {
                        node = prevNode;
                        offset = prevNode.textContent.length;
                        textBefore = prevNode.textContent;
                    }
                }
                const match = textBefore.match(/([1-3]?[\uAC00-\uD7A3\u3131-\u314E]{1,5})\s*(\d+)(?:\s*[::\uC7A5]\s*|\s+)(\d+)(?:\s*[-~]\s*(\d+))?\s*$/);
                if (match) {
                    const replaceRange = document.createRange();
                    replaceRange.setStart(node, offset - match[0].length);
                    replaceRange.setEnd(node, offset);
                    processVerseInsertion(match[0], match[1], match[2], match[3], match[4] || match[3], replaceRange);
                }
            }
        }

        if (isTriggerChar) {
            debouncedDetectBibleRefs(editor.textContent);
        }
    });

    editor.addEventListener('blur', () => {
        debouncedDetectBibleRefs(editor.innerText);
    });

    editor.addEventListener('input', deferCaretCheck);

    editor.addEventListener('keydown', (e) => {
        triggerTypingMode();
    });

    editor.addEventListener('keyup', (e) => {
        autoSave();
        const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
        if (navKeys.includes(e.key)) {
            debouncedSync();
        }
    });

    editor.addEventListener('focus', () => {
        window._lastActiveEditor = editor;
        document.body.classList.add('editor-focused');
        const header = document.querySelector('.editor-sticky-header');
        if (header) {
            document.body.style.setProperty('--header-height', header.offsetHeight + 'px');
        }
        deferCaretCheck();
        // Run delayed checks to ensure caret visibility after keyboard animation completes
        setTimeout(ensureCaretIsVisible, 150);
        setTimeout(ensureCaretIsVisible, 300);
        setTimeout(ensureCaretIsVisible, 500);
    });

    editor.addEventListener('blur', () => {
        document.body.classList.remove('editor-focused');
        document.querySelector('.view-container')?.classList.remove('is-typing');
        document.body.classList.remove('typing-mode');
    });

    editor.addEventListener('click', () => {
        debouncedSync();
    });

    const savedStyle = localStorage.getItem('noteLineStyle') || 'none';
    if (savedStyle !== 'none') editor.classList.add(`note-${savedStyle}`);
    const savedBg = localStorage.getItem('noteBgColor') || 'default';
    if (savedBg !== 'default') editor.style.backgroundColor = savedBg;

    // 캔버스 (펜 기능)
    const canvas = document.createElement('canvas');
    canvas.className = 'pen-canvas';
    canvas.style.display = state.isDrawingMode ? 'block' : 'none';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = state.isDrawingMode ? 'auto' : 'none';

    canvas.addEventListener('pointerdown', penStartDraw, { passive: false });
    canvas.addEventListener('pointermove', penDraw, { passive: false });
    canvas.addEventListener('pointerup', penStopDraw, { passive: false });
    canvas.addEventListener('pointercancel', penStopDraw, { passive: false });
    canvas.addEventListener('pointerleave', penStopDraw, { passive: false });

    pageEl.appendChild(editor);
    pageEl.appendChild(canvas);
    pageEl.addEventListener('click', (e) => {
        if (e.target === pageEl && editor && !state.isDrawingMode) {
            editor.focus();
        }
    });
    wrap.appendChild(pageEl);

    loadDrawingForCanvas(canvas, editor, page.drawingData);
}

function moveOverflowingContent(sourceEditor, targetEditor, maxHeight) {
    moveOverflowingContentInner(sourceEditor, sourceEditor, targetEditor, maxHeight);
}

function moveOverflowingContentInner(mainEditor, sourceNode, targetNode, maxHeight) {
    while (mainEditor.scrollHeight > maxHeight + 5 && sourceNode.lastChild) {
        let lastNode = sourceNode.lastChild;

        if (lastNode.nodeType === Node.TEXT_NODE && lastNode.nodeValue.length > 5) {
            const originalText = lastNode.nodeValue;
            let low = 0, high = originalText.length, best = 0;
            while (low <= high) {
                let mid = Math.floor((low + high) / 2);
                lastNode.nodeValue = originalText.substring(0, mid);
                if (mainEditor.scrollHeight <= maxHeight + 5) {
                    best = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }
            
            if (best > 0 && best < originalText.length) {
                lastNode.nodeValue = originalText.substring(0, best);
                const overflowText = originalText.substring(best);
                const newNode = document.createTextNode(overflowText);
                targetNode.insertBefore(newNode, targetNode.firstChild);
                break;
            } else {
                lastNode.nodeValue = originalText;
                targetNode.insertBefore(lastNode, targetNode.firstChild);
            }
        } else if (lastNode.nodeType === Node.ELEMENT_NODE && lastNode.childNodes.length > 0 && lastNode.tagName !== 'BR') {
             let newEl = document.createElement(lastNode.tagName);
             if (lastNode.className) newEl.className = lastNode.className;
             if (lastNode.style && lastNode.style.cssText) newEl.style.cssText = lastNode.style.cssText;
             // Copy all HTML attributes (e.g. face, style, data-*) so they survive page overflow
             if (lastNode.attributes) {
                 Array.from(lastNode.attributes).forEach(attr => {
                     if (attr.name !== 'class' && attr.name !== 'style') {
                         newEl.setAttribute(attr.name, attr.value);
                     }
                 });
             }
             targetNode.insertBefore(newEl, targetNode.firstChild);
             
             moveOverflowingContentInner(mainEditor, lastNode, newEl, maxHeight);
             
             if (lastNode.childNodes.length === 0) {
                 sourceNode.removeChild(lastNode);
             }
             if (newEl.childNodes.length === 0) {
                 targetNode.removeChild(newEl);
             }
        } else {
            targetNode.insertBefore(lastNode, targetNode.firstChild);
        }
    }
}

function isSelectionInside(element) {
    if (!element) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    try {
        return element.contains(sel.anchorNode) || element.contains(sel.focusNode);
    } catch(e) {
        return false;
    }
}

function getCaretCharacterOffsetWithin(element) {
    let caretOffset = 0;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        try {
            const range = sel.getRangeAt(0);
            const preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(element);
            preCaretRange.setEnd(range.endContainer, range.endOffset);
            caretOffset = preCaretRange.toString().length;
        } catch(e) {}
    }
    return caretOffset;
}

function setCaretCharacterOffsetWithin(element, offset) {
    if (!element) return;
    const sel = window.getSelection();
    const range = document.createRange();
    let currentLen = 0;
    let found = false;

    function traverseNodes(node) {
        if (found) return;
        if (node.nodeType === Node.TEXT_NODE) {
            const nextLen = currentLen + node.length;
            if (offset <= nextLen) {
                range.setStart(node, Math.max(0, offset - currentLen));
                range.collapse(true);
                found = true;
                return;
            }
            currentLen = nextLen;
        } else {
            for (let i = 0; i < node.childNodes.length; i++) {
                traverseNodes(node.childNodes[i]);
                if (found) return;
            }
        }
    }

    traverseNodes(element);
    if (!found) {
        range.selectNodeContents(element);
        range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
}

// ✅ FIX #3: 디바운스된 무거운 페이지 처리 핸들러 (입력 도중 레이아웃 강제 연산 방지)
const debouncedHandleEditorInput = debounce((target) => {
    if (window._isPaginating || !state.notes[state.currentNoteId]) return;
    
    const editor = target;
    const pageEl = editor.closest('.a4-page-wrapper');
    if (!pageEl) return;
    const index = parseInt(pageEl.dataset.index);
    const ratio = 1.414;
    const maxHeight = editor.offsetWidth * ratio;
    
    // 1. PUSH text forward if overflowing
    if (editor.scrollHeight > maxHeight + 15) {
        const note = state.notes[state.currentNoteId];
        const caretWasInEditor = isSelectionInside(editor);
        const savedCaretOffset = caretWasInEditor ? getCaretCharacterOffsetWithin(editor) : 0;

        if (index === note.pages.length - 1) {
            window._isPaginating = true;
            saveAllPages(true);
            note.pages.push({ content: '', drawingData: null });
            
            // ✅ FIX 3: renderAllPages 실행 전 STT 상태 저장
            const sttWasActive = isRecording && !!speechRecognition;
            
            renderAllPages(note);
            
            const newEditors = document.querySelectorAll('.sermon-editor');
            const oldEditor = newEditors[index];
            const nextEditor = newEditors[index + 1];

            if (oldEditor && nextEditor) {
                moveOverflowingContent(oldEditor, nextEditor, maxHeight);
                
                const caretNowInNext = isSelectionInside(nextEditor);

                if (caretNowInNext) {
                    state.currentPageIndex = index + 1;
                    updatePageNavigator();
                    nextEditor.focus();
                    window._lastActiveEditor = nextEditor;
                    nextEditor.closest('.a4-page-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else if (caretWasInEditor) {
                    state.currentPageIndex = index;
                    updatePageNavigator();
                    oldEditor.focus();
                    window._lastActiveEditor = oldEditor;
                    setCaretCharacterOffsetWithin(oldEditor, savedCaretOffset);
                }

                if (nextEditor.scrollHeight > maxHeight + 15) {
                    setTimeout(() => { 
                        window._isPaginating = false;
                        if (sttWasActive && isRecording && !speechRecognition) {
                            const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
                            if (SpeechRecognitionClass) {
                                speechRecognition = initSpeechRecognition(SpeechRecognitionClass);
                                try { speechRecognition.start(); } catch(e) {}
                            }
                        }
                        debouncedHandleEditorInput(nextEditor);
                    }, 50);
                    return;
                }
            }
            // ✅ FIX 3: STT 재연결 (일반 케이스)
            setTimeout(() => {
                window._isPaginating = false;
                if (sttWasActive && isRecording && !speechRecognition) {
                    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
                    if (SpeechRecognitionClass) {
                        speechRecognition = initSpeechRecognition(SpeechRecognitionClass);
                        try { speechRecognition.start(); } catch(e) {}
                    }
                }
            }, 500);
            return;
        } else {
            const editors = document.querySelectorAll('.sermon-editor');
            const nextEditor = editors[index + 1];
            if (nextEditor) {
                window._isPaginating = true;
                
                moveOverflowingContent(editor, nextEditor, maxHeight);
                
                const caretNowInNext = isSelectionInside(nextEditor);

                if (caretNowInNext) {
                    nextEditor.focus();
                    window._lastActiveEditor = nextEditor;
                    state.currentPageIndex = index + 1;
                    updatePageNavigator();
                    nextEditor.closest('.a4-page-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else if (caretWasInEditor) {
                    editor.focus();
                    window._lastActiveEditor = editor;
                    setCaretCharacterOffsetWithin(editor, savedCaretOffset);
                }
                
                if (nextEditor.scrollHeight > maxHeight + 15) {
                    setTimeout(() => { 
                        window._isPaginating = false; 
                        debouncedHandleEditorInput(nextEditor);
                    }, 50);
                } else {
                    setTimeout(() => { window._isPaginating = false; }, 100);
                }
            }
        }
    }
    
    // 2. PULL text back if underflowing and next page exists
    const currentEditors = document.querySelectorAll('.sermon-editor');
    const nextEditor = currentEditors[index + 1];
    if (nextEditor) {
        let pulled = false;
        while (editor.scrollHeight < maxHeight && nextEditor.firstChild) {
            editor.appendChild(nextEditor.firstChild);
            pulled = true;
            if (editor.scrollHeight > maxHeight + 5) {
                nextEditor.insertBefore(editor.lastChild, nextEditor.firstChild);
                break;
            }
        }
        if (pulled) {
            saveAllPages(true);
        }
    }
    
    // 3. AUTO-DELETE empty pages if they are not active
    const note = state.notes[state.currentNoteId];
    if (note && note.pages) {
        let changed = false;
        const activeEditor = document.activeElement;
        const updatedEditors = document.querySelectorAll('.sermon-editor');
        for (let i = note.pages.length - 1; i > 0; i--) {
            const ed = updatedEditors[i];
            if (ed && ed.innerText.trim() === '' && ed !== activeEditor) {
                note.pages.splice(i, 1);
                changed = true;
            }
        }
        if (changed) {
            window._isPaginating = true;
            saveAllPages(true);
            renderAllPages(note);
            if (state.currentPageIndex >= note.pages.length) {
                state.currentPageIndex = note.pages.length - 1;
            }
            updatePageNavigator();
            setTimeout(() => { window._isPaginating = false; }, 200);
        }
    }
}, 300);

// 가벼운 동기식 input 핸들러 (UI 스레드 차단 방지)
function handleEditorInput(e) {
    if (!state.notes[state.currentNoteId]) return;
    const editor = e.target;
    if (editor.innerText.trim() === '') {
        editor.classList.add('show-placeholder');
    } else {
        editor.classList.remove('show-placeholder');
    }
    // 글자 되돌리기용 상태 저장
    if (typeof recordEditorTextState === 'function') {
        recordEditorTextState(editor);
    }
}

function getCanvasDataURL(canvas) {
    if (!canvas || canvas.width <= 1 || canvas.height <= 1) return null;
    try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;
        let hasContent = false;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) {
                hasContent = true;
                break;
            }
        }
        if (!hasContent) return null;
        
        try {
            const webp = canvas.toDataURL('image/webp', 0.7);
            if (webp && webp.startsWith('data:image/webp')) return webp;
        } catch(e) {}
        return canvas.toDataURL('image/png');
    } catch (e) {
        return null;
    }
}

function saveAllPages(skipCanvas = false) {
    const note = state.notes[state.currentNoteId];
    if (!note) return;
    const wrapper = document.querySelector('.a4-page-wrapper');
    if (!wrapper) return;
    const editor = wrapper.querySelector('.sermon-editor');
    const canvas = wrapper.querySelector('.pen-canvas');
    let drawingData = (note.pages && note.pages[0]) ? note.pages[0].drawingData : null;
    if (!skipCanvas && canvas && canvas.width > 1) {
        drawingData = getCanvasDataURL(canvas);
    }
    note.pages = [{ content: editor ? editor.innerHTML : '', drawingData }];
}

function initPageObserver() {
    // 단일 페이지 모드: 페이지 감지 불필요
}

// --- Recording List UI ---
function renderRecordList() {
    const container = document.getElementById('record-list-container');
    if (!container) return;
    
    RecordDB.getAll().then(records => {
        container.innerHTML = '';
        if (records.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding: 1rem; color: var(--text-muted); font-size: 0.9rem;">저장된 녹음 파일이 없습니다.</div>';
            return;
        }
        
        records.forEach(rec => {
            const item = document.createElement('div');
            item.className = 'record-item';
            item.style.cssText = 'background: var(--bg-main); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.8rem; display: flex; flex-direction: column; gap: 0.5rem;';
            
            const header = document.createElement('div');
            header.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
            
            const titleDate = document.createElement('div');
            titleDate.innerHTML = `<div style="font-weight: 600; color: var(--text-main); font-size: 0.95rem;">${rec.title}</div>
                                   <div style="font-size: 0.75rem; color: var(--text-muted);">${rec.dateStr}</div>`;
            
            const actions = document.createElement('div');
            actions.style.cssText = 'display: flex; gap: 0.3rem;';
            
            const audioUrl = URL.createObjectURL(rec.blob);
            const audioEl = document.createElement('audio');
            audioEl.src = audioUrl;
            audioEl.controls = true;
            audioEl.style.cssText = 'width: 100%; height: 36px; margin-top: 0.3rem;';
            
            const dlBtn = document.createElement('button');
            dlBtn.className = 'icon-btn';
            dlBtn.innerHTML = '<i class="fas fa-download"></i>';
            dlBtn.title = '다운로드';
            dlBtn.onclick = () => {
                const a = document.createElement('a');
                a.href = audioUrl;
                a.download = `${rec.title.replace(/\\s+/g, '_')}_${rec.dateStr.replace(/\\./g, '')}.webm`;
                a.click();
            };
            
            const delBtn = document.createElement('button');
            delBtn.className = 'icon-btn';
            delBtn.innerHTML = '<i class="fas fa-trash-alt" style="color: #ef4444;"></i>';
            delBtn.title = '삭제';
            delBtn.onclick = () => {
                if (confirm('이 녹음 파일을 삭제하시겠습니까?')) {
                    RecordDB.delete(rec.id).then(() => renderRecordList());
                }
            };
            
            actions.appendChild(dlBtn);
            actions.appendChild(delBtn);
            
            header.appendChild(titleDate);
            header.appendChild(actions);
            
            item.appendChild(header);
            item.appendChild(audioEl);
            
            container.appendChild(item);
        });
    }).catch(console.error);
}

document.addEventListener('DOMContentLoaded', () => {
    const listBtn = document.getElementById('menu-record-list-btn');
    const modal = document.getElementById('record-list-modal');
    const closeBtn = document.getElementById('record-list-close-btn');
    const menuMoreOptions = document.getElementById('editor-more-menu');
    
    if (listBtn) {
        listBtn.addEventListener('click', () => {
            renderRecordList();
            if (modal) modal.classList.add('active');
            if (menuMoreOptions) menuMoreOptions.style.display = 'none';
        });
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            if (modal) {
                modal.classList.remove('active');
                const audios = modal.querySelectorAll('audio');
                audios.forEach(a => a.pause());
            }
        });
    }
});

/* ==========================================================================
   Data Export / Import (Device Migration & Backup)
   ========================================================================== */

async function exportAppData() {
    showToast("백업 파일을 생성하는 중입니다...");
    try {
        const keys = getUserStorageKeys();
        const rawNotes = localStorage.getItem(keys.notes);
        const rawDeletedNotes = localStorage.getItem(keys.deletedNotes);
        const rawWorshipTypes = localStorage.getItem(keys.worshipTypes);
        const rawExpandedWT = localStorage.getItem(keys.expandedWorshipTypes);

        const notes = rawNotes ? JSON.parse(rawNotes) : (state.notes || {});
        const deletedNotes = rawDeletedNotes ? JSON.parse(rawDeletedNotes) : (state.deletedNotes || []);
        const worshipTypes = rawWorshipTypes ? JSON.parse(rawWorshipTypes) : (state.worshipTypes || ['주일예배', '금요예배']);
        const expandedWorshipTypes = rawExpandedWT ? JSON.parse(rawExpandedWT) : (state.expandedWorshipTypes || []);

        const settings = {
            theme: localStorage.getItem('app_theme') || state.theme || 'light',
            fontSize: state.fontSize || 16,
            bibleFontSize: localStorage.getItem('app_bible_font_size') || state.bibleFontSize || 15,
            bibleVersion: localStorage.getItem('app_bible_version') || state.bibleVersion || 'NKRV',
            homeViewMode: localStorage.getItem('home_view_mode') || 'worship',
            homeFilterType: localStorage.getItem('home_filter_type') || 'all'
        };

        // Fetch recordings from IndexedDB
        let recordings = [];
        try {
            if (RecordDB && RecordDB.db) {
                const rawRecordings = await RecordDB.getAll();
                if (Array.isArray(rawRecordings)) {
                    for (const rec of rawRecordings) {
                        let base64Blob = null;
                        if (rec.blob) {
                            base64Blob = await new Promise((resolve) => {
                                const reader = new FileReader();
                                reader.onloadend = () => resolve(reader.result);
                                reader.onerror = () => resolve(null);
                                reader.readAsDataURL(rec.blob);
                            });
                        }
                        recordings.push({
                            id: rec.id,
                            title: rec.title,
                            dateStr: rec.dateStr,
                            noteId: rec.noteId,
                            timestamp: rec.timestamp,
                            blobData: base64Blob
                        });
                    }
                }
            }
        } catch (e) {
            console.warn("Export recordings warn:", e);
        }

        const backupData = {
            appName: "GoodSermonNote",
            version: 1,
            exportDate: new Date().toISOString(),
            notes,
            deletedNotes,
            worshipTypes,
            expandedWorshipTypes,
            settings,
            recordings
        };

        const jsonStr = JSON.stringify(backupData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const a = document.createElement('a');
        a.href = url;
        a.download = `GoodSermonNote_Backup_${dateTag}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast("데이터 백업 파일이 다운로드되었습니다.");
    } catch (err) {
        console.error("Export error:", err);
        alert("백업 생성 중 오류가 발생했습니다: " + err.message);
    }
}

function triggerImportData() {
    const fileInput = document.getElementById('import-file-input');
    if (fileInput) {
        fileInput.value = '';
        fileInput.click();
    }
}

async function handleImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!confirm("백업 파일의 데이터로 이 기기에 복원하시겠습니까?\n(기존 데이터와 백업 데이터가 통합되어 저장됩니다.)")) {
        return;
    }

    showToast("데이터 복원 중입니다. 잠시만 기다려 주세요...");

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data || (!data.notes && !data.appName)) {
            alert("올바른 백업 파일(.json) 형식이 아닙니다.");
            return;
        }

        const keys = getUserStorageKeys();

        // 1. Restore Notes
        if (data.notes && typeof data.notes === 'object') {
            const currentRaw = localStorage.getItem(keys.notes);
            let currentNotes = currentRaw ? JSON.parse(currentRaw) : {};
            Object.keys(data.notes).forEach(id => {
                currentNotes[id] = data.notes[id];
            });
            state.notes = currentNotes;
            localStorage.setItem(keys.notes, JSON.stringify(state.notes));
        }

        // 2. Restore Deleted Notes
        if (Array.isArray(data.deletedNotes)) {
            const existingDeleted = state.deletedNotes || [];
            const merged = Array.from(new Set([...existingDeleted, ...data.deletedNotes]));
            state.deletedNotes = merged;
            localStorage.setItem(keys.deletedNotes, JSON.stringify(state.deletedNotes));
        }

        // 3. Restore Worship Types
        if (Array.isArray(data.worshipTypes)) {
            const existingWT = state.worshipTypes || ['주일예배', '금요예배'];
            const mergedWT = Array.from(new Set([...existingWT, ...data.worshipTypes]));
            state.worshipTypes = mergedWT;
            localStorage.setItem(keys.worshipTypes, JSON.stringify(state.worshipTypes));
        }

        // 4. Restore Settings
        if (data.settings) {
            if (data.settings.theme) {
                state.theme = data.settings.theme;
                localStorage.setItem('app_theme', state.theme);
                applyTheme();
            }
            if (data.settings.fontSize) {
                state.fontSize = data.settings.fontSize;
            }
            if (data.settings.bibleFontSize) {
                state.bibleFontSize = data.settings.bibleFontSize;
                localStorage.setItem('app_bible_font_size', state.bibleFontSize);
                applyBibleFontSize();
            }
            if (data.settings.bibleVersion) {
                state.bibleVersion = data.settings.bibleVersion;
                localStorage.setItem('app_bible_version', state.bibleVersion);
            }
        }

        // 5. Restore Recordings to IndexedDB
        if (Array.isArray(data.recordings) && data.recordings.length > 0 && RecordDB && RecordDB.db) {
            for (const rec of data.recordings) {
                if (rec.id && rec.blobData) {
                    try {
                        const res = await fetch(rec.blobData);
                        const blob = await res.blob();
                        await RecordDB.save(rec.id, rec.title || '녹음', rec.dateStr || '', blob, rec.noteId || null);
                    } catch (e) {
                        console.warn("Failed to restore recording:", rec.id, e);
                    }
                }
            }
        }

        // 6. Refresh UI
        renderHomeNotes();
        renderCalendar();
        renderWorshipTypes();
        showToast("데이터가 성공적으로 복원되었습니다!");
    } catch (err) {
        console.error("Import error:", err);
        alert("데이터 복원 중 오류가 발생했습니다: " + err.message);
    }
}

// ============================================
// 3축 구조: 탭 전환 및 성경 읽기/검색
// ============================================

// --- Tab State ---
let currentTab = 'sermon'; // 'bible', 'search', 'sermon'
let readerVersion = localStorage.getItem('app_bible_version') || 'NKRV';
let searchVersion = localStorage.getItem('app_bible_version') || 'NKRV';
let bibleReaderState = { level: 'books', bookId: null, bookName: '', chapter: null, totalChapters: 0 };

// 각 책의 장 수 (구약 39권 + 신약 27권 = 66권)
const BIBLE_CHAPTER_COUNTS = [
    50,40,27,36,34,24,21,4,31,24,22,25,29,36,10,13,10,42,150,31,12,8,66,52,5,48,12,14,3,9,1,4,7,3,3,3,2,14,4, // 구약 39권
    28,16,24,21,28,16,16,13,6,6,4,4,5,3,6,4,3,1,13,5,5,3,5,1,1,1,22 // 신약 27권
];

// 66권 전체 정보 (이름, 약어, 구약/신약)
const BIBLE_BOOK_INFO = [
    { id:1, name:'창세기', abbr:'창', testament:'ot' },
    { id:2, name:'출애굽기', abbr:'출', testament:'ot' },
    { id:3, name:'레위기', abbr:'레', testament:'ot' },
    { id:4, name:'민수기', abbr:'민', testament:'ot' },
    { id:5, name:'신명기', abbr:'신', testament:'ot' },
    { id:6, name:'여호수아', abbr:'수', testament:'ot' },
    { id:7, name:'사사기', abbr:'삿', testament:'ot' },
    { id:8, name:'룻기', abbr:'룻', testament:'ot' },
    { id:9, name:'사무엘상', abbr:'삼상', testament:'ot' },
    { id:10, name:'사무엘하', abbr:'삼하', testament:'ot' },
    { id:11, name:'열왕기상', abbr:'왕상', testament:'ot' },
    { id:12, name:'열왕기하', abbr:'왕하', testament:'ot' },
    { id:13, name:'역대상', abbr:'대상', testament:'ot' },
    { id:14, name:'역대하', abbr:'대하', testament:'ot' },
    { id:15, name:'에스라', abbr:'스', testament:'ot' },
    { id:16, name:'느헤미야', abbr:'느', testament:'ot' },
    { id:17, name:'에스더', abbr:'에', testament:'ot' },
    { id:18, name:'욥기', abbr:'욥', testament:'ot' },
    { id:19, name:'시편', abbr:'시', testament:'ot' },
    { id:20, name:'잠언', abbr:'잠', testament:'ot' },
    { id:21, name:'전도서', abbr:'전', testament:'ot' },
    { id:22, name:'아가', abbr:'아', testament:'ot' },
    { id:23, name:'이사야', abbr:'사', testament:'ot' },
    { id:24, name:'예레미야', abbr:'렘', testament:'ot' },
    { id:25, name:'예레미야애가', abbr:'애', testament:'ot' },
    { id:26, name:'에스겔', abbr:'겔', testament:'ot' },
    { id:27, name:'다니엘', abbr:'단', testament:'ot' },
    { id:28, name:'호세아', abbr:'호', testament:'ot' },
    { id:29, name:'요엘', abbr:'욜', testament:'ot' },
    { id:30, name:'아모스', abbr:'암', testament:'ot' },
    { id:31, name:'오바댜', abbr:'오', testament:'ot' },
    { id:32, name:'요나', abbr:'요나', testament:'ot' },
    { id:33, name:'미가', abbr:'미', testament:'ot' },
    { id:34, name:'나훔', abbr:'나', testament:'ot' },
    { id:35, name:'하박국', abbr:'합', testament:'ot' },
    { id:36, name:'스바냐', abbr:'습', testament:'ot' },
    { id:37, name:'학개', abbr:'학', testament:'ot' },
    { id:38, name:'스가랴', abbr:'슥', testament:'ot' },
    { id:39, name:'말라기', abbr:'말', testament:'ot' },
    { id:40, name:'마태복음', abbr:'마', testament:'nt' },
    { id:41, name:'마가복음', abbr:'막', testament:'nt' },
    { id:42, name:'누가복음', abbr:'눅', testament:'nt' },
    { id:43, name:'요한복음', abbr:'요', testament:'nt' },
    { id:44, name:'사도행전', abbr:'행', testament:'nt' },
    { id:45, name:'로마서', abbr:'롬', testament:'nt' },
    { id:46, name:'고린도전서', abbr:'고전', testament:'nt' },
    { id:47, name:'고린도후서', abbr:'고후', testament:'nt' },
    { id:48, name:'갈라디아서', abbr:'갈', testament:'nt' },
    { id:49, name:'에베소서', abbr:'엡', testament:'nt' },
    { id:50, name:'빌립보서', abbr:'빌', testament:'nt' },
    { id:51, name:'골로새서', abbr:'골', testament:'nt' },
    { id:52, name:'데살로니가전서', abbr:'살전', testament:'nt' },
    { id:53, name:'데살로니가후서', abbr:'살후', testament:'nt' },
    { id:54, name:'디모데전서', abbr:'딤전', testament:'nt' },
    { id:55, name:'디모데후서', abbr:'딤후', testament:'nt' },
    { id:56, name:'디도서', abbr:'딛', testament:'nt' },
    { id:57, name:'빌레몬서', abbr:'몬', testament:'nt' },
    { id:58, name:'히브리서', abbr:'히', testament:'nt' },
    { id:59, name:'야고보서', abbr:'약', testament:'nt' },
    { id:60, name:'베드로전서', abbr:'벧전', testament:'nt' },
    { id:61, name:'베드로후서', abbr:'벧후', testament:'nt' },
    { id:62, name:'요한1서', abbr:'요1', testament:'nt' },
    { id:63, name:'요한2서', abbr:'요2', testament:'nt' },
    { id:64, name:'요한3서', abbr:'요3', testament:'nt' },
    { id:65, name:'유다서', abbr:'유', testament:'nt' },
    { id:66, name:'요한계시록', abbr:'계', testament:'nt' }
];

// --- 성경 약어 매핑 (66권 전체 약어 및 풀네임 지원) ---
const BIBLE_ABBR_MAP = {
    '창': 1, '창세': 1, '창세기': 1,
    '출': 2, '출애': 2, '출애굽': 2, '출애굽기': 2,
    '레': 3, '레위': 3, '레위기': 3,
    '민': 4, '민수': 4, '민수기': 4,
    '신': 5, '신명': 5, '신명기': 5,
    '수': 6, '여호': 6, '여호수아': 6,
    '삿': 7, '사사': 7, '사사기': 7,
    '룻': 8, '룻기': 8,
    '삼상': 9, '사무엘상': 9,
    '삼하': 10, '사무엘하': 10,
    '왕상': 11, '열왕기상': 11,
    '왕하': 12, '열왕기하': 12,
    '대상': 13, '역대상': 13,
    '대하': 14, '역대하': 14,
    '스': 15, '에스라': 15,
    '느': 16, '느헤': 16, '느헤미야': 16,
    '에': 17, '에스더': 17,
    '욥': 18, '욥기': 18,
    '시': 19, '시편': 19,
    '잠': 20, '잠언': 20,
    '전': 21, '전도': 21, '전도서': 21,
    '아': 22, '아가': 22,
    '사': 23, '이사': 23, '이사야': 23,
    '렘': 24, '예레': 24, '예레미야': 24,
    '애': 25, '예레미야애가': 25, '애가': 25,
    '겔': 26, '에스겔': 26,
    '단': 27, '다니엘': 27,
    '호': 28, '호세아': 28,
    '욜': 29, '요엘': 29,
    '암': 30, '아모스': 30,
    '오': 31, '오바댜': 31,
    '요나': 32,
    '미': 33, '미가': 33,
    '나': 34, '나훔': 34,
    '합': 35, '하박국': 35,
    '습': 36, '스바냐': 36,
    '학': 37, '학개': 37,
    '슥': 38, '스가랴': 38,
    '말': 39, '말라기': 39,
    '마': 40, '마태': 40, '마태복음': 40,
    '막': 41, '마가': 41, '마가복음': 41,
    '눅': 42, '누가': 42, '누가복음': 42,
    '요': 43, '요한': 43, '요한복음': 43,
    '행': 44, '사도': 44, '사도행전': 44,
    '롬': 45, '로마': 45, '로마서': 45,
    '고전': 46, '고린도전서': 46,
    '고후': 47, '고린도후서': 47,
    '갈': 48, '갈라': 48, '갈라디아서': 48,
    '엡': 49, '에베': 49, '에베소서': 49,
    '빌': 50, '빌립': 50, '빌립보서': 50,
    '골': 51, '골로': 51, '골로새서': 51,
    '살전': 52, '데살로니가전서': 52,
    '살후': 53, '데살로니가후서': 53,
    '딤전': 54, '디모데전서': 54,
    '딤후': 55, '디모데후서': 55,
    '딛': 56, '디도': 56, '디도서': 56,
    '몬': 57, '빌레': 57, '빌레몬서': 57,
    '히': 58, '히브': 58, '히브리서': 58,
    '약': 59, '야고': 59, '야고보서': 59,
    '벧전': 60, '베드로전서': 60,
    '벧후': 61, '베드로후서': 61,
    '요1': 62, '요일': 62, '요한1서': 62, '요한일서': 62,
    '요2': 63, '요이': 63, '요한2서': 63, '요한이서': 63,
    '요3': 64, '요삼': 64, '요한3서': 64, '요한삼서': 64,
    '유': 65, '유다': 65, '유다서': 65,
    '계': 66, '계시': 66, '요한계시록': 66
};

// 성경 약어 쿼리 파싱 함수 (예: '요 1 1', '요 1:1', '요1:1', '요1 1', '롬 8 28', '창 1:1', '시 23')
function parseBibleAbbrQuery(query) {
    if (!query) return null;
    let s = query.trim();
    
    // 정규식: 한글/영문 약어 + 장번호 + [구분자] + [절번호]
    const m = s.match(/^([가-힣0-9a-zA-Z]+?)\s*(\d+)[\s:장절,]*(.*)$/);
    if (!m) return null;

    let bookKey = m[1].trim();
    let chapter = parseInt(m[2], 10);
    let versePart = m[3] ? m[3].replace(/[절\s]/g, '').trim() : '';
    let verse = versePart ? parseInt(versePart, 10) : null;

    // 책 이름 매핑 확인
    let bookId = BIBLE_ABBR_MAP[bookKey];
    if (!bookId) {
        // 혹시 전체 이름이나 부분 일치 검색
        const found = BIBLE_BOOK_INFO.find(b => b.name === bookKey || b.abbr === bookKey || b.name.startsWith(bookKey));
        if (found) bookId = found.id;
    }

    if (!bookId) return null;

    if (isNaN(chapter) || chapter < 1) chapter = 1;
    const maxChapters = BIBLE_CHAPTER_COUNTS[bookId - 1] || 1;
    if (chapter > maxChapters) chapter = maxChapters;

    return { bookId, chapter, verse };
}

// 약어 검색 핸들러
function handleBibleQuickJump() {
    const input = document.getElementById('bible-quick-input');
    if (!input) return;
    const query = input.value.trim();
    if (!query) {
        showToast && showToast('성경 약어와 구절을 입력해주세요. (예: 요 1 1 또는 요 1:1)', 'warning', 3000);
        input.focus();
        return;
    }

    const parsed = parseBibleAbbrQuery(query);
    if (!parsed) {
        showToast && showToast('성경 약어를 인식하지 못했습니다. (예: 요 1 1, 창 1:1, 롬 8 28)', 'warning', 3500);
        return;
    }

    // 바로 성경 구절로 이동 & 하이라이트
    selectBibleChapter(parsed.bookId, parsed.chapter, parsed.verse);
    input.value = '';
}

// 성경 빠른 검색 이벤트 바인딩
function initBibleQuickJump() {
    const btn = document.getElementById('bible-quick-btn');
    const input = document.getElementById('bible-quick-input');
    if (btn && !btn._bound) {
        btn._bound = true;
        btn.onclick = (e) => {
            e.preventDefault();
            handleBibleQuickJump();
        };
    }
    if (input && !input._bound) {
        input._bound = true;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleBibleQuickJump();
            }
        };
    }
}

// --- Main Home View (말씀카드 메인 홈) ---
function showMainHome(pushState = true) {
    currentTab = 'home';
    state.view = 'home';
    state.currentNoteId = null;

    const bibleView = document.getElementById('bible-reader-view');
    const searchView = document.getElementById('bible-search-view');
    const editorView = document.getElementById('editor-bible-view');
    const homeView = document.getElementById('home-view');
    const heroCard = document.getElementById('home-hero-card');
    const contentArea = document.getElementById('home-content-area');
    const tabBar = document.getElementById('bottom-tab-bar');
    const sermonToMainBtn = document.getElementById('sermon-to-main-btn');

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-home')?.classList.add('active');

    if (bibleView) { bibleView.classList.remove('active'); bibleView.style.display = 'none'; }
    if (searchView) { searchView.classList.remove('active'); searchView.style.display = 'none'; }
    if (editorView) { editorView.classList.remove('active'); editorView.style.display = 'none'; }

    if (homeView) {
        homeView.classList.add('active');
        homeView.classList.remove('show-notes-list');
        homeView.style.display = 'flex';
    }

    if (sermonToMainBtn) sermonToMainBtn.style.display = 'none';

    // 메인 홈: 말씀 카드만 보이고, 설교노트 목록은 안보임
    if (heroCard) heroCard.style.display = 'flex';
    if (contentArea) contentArea.style.display = 'none';
    if (tabBar) tabBar.classList.remove('hidden');

    if (pushState && location.hash !== '#home') {
        history.pushState({ view: 'home' }, '', '#home');
    }
}

// --- Tab Switching ---
function switchTab(tab, pushState = true) {
    if (tab === 'home' || tab === 'home_main') {
        showMainHome(pushState);
        return;
    }

    currentTab = tab;
    const tabBar = document.getElementById('bottom-tab-bar');
    const bibleView = document.getElementById('bible-reader-view');
    const searchView = document.getElementById('bible-search-view');
    const homeView = document.getElementById('home-view');
    const editorView = document.getElementById('editor-bible-view');
    const heroCard = document.getElementById('home-hero-card');
    const contentArea = document.getElementById('home-content-area');
    const sermonToMainBtn = document.getElementById('sermon-to-main-btn');

    // Deactivate all tab buttons
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    // Hide all main views
    if (bibleView) {
        bibleView.classList.remove('active');
        bibleView.style.display = 'none';
    }
    if (searchView) {
        searchView.classList.remove('active');
        searchView.style.display = 'none';
    }
    if (homeView) {
        homeView.classList.remove('active');
        homeView.style.display = 'none';
    }
    if (editorView) {
        editorView.classList.remove('active');
        editorView.style.display = 'none';
    }

    // Show tab bar
    if (tabBar) tabBar.classList.remove('hidden');

    switch (tab) {
        case 'bible':
            document.getElementById('tab-bible')?.classList.add('active');
            if (bibleView) {
                bibleView.classList.add('active');
                bibleView.style.display = 'flex';
            }
            if (heroCard) heroCard.style.display = 'none';
            if (contentArea) contentArea.style.display = 'none';
            if (sermonToMainBtn) sermonToMainBtn.style.display = 'none';
            initBibleQuickJump();
            renderBibleBooks();
            break;
        case 'search':
            document.getElementById('tab-search')?.classList.add('active');
            if (searchView) {
                searchView.classList.add('active');
                searchView.style.display = 'flex';
            }
            if (heroCard) heroCard.style.display = 'none';
            if (contentArea) contentArea.style.display = 'none';
            if (sermonToMainBtn) sermonToMainBtn.style.display = 'none';
            setTimeout(() => {
                const input = document.getElementById('bible-search-input');
                if (input) input.focus();
            }, 300);
            break;
        case 'sermon':
            document.getElementById('tab-sermon')?.classList.add('active');
            if (homeView) {
                homeView.classList.add('active');
                homeView.style.display = 'flex';
            }
            // 하단부 설교노트 버튼을 눌러야 설교노트 목록이 보이고, 상단부 말씀카드는 안보임
            if (heroCard) heroCard.style.display = 'none';
            if (contentArea) contentArea.style.display = 'block';
            if (sermonToMainBtn) sermonToMainBtn.style.display = 'inline-flex';

            if (state.view === 'editor' && state.currentNoteId) {
                if (editorView) {
                    editorView.classList.add('active');
                    editorView.style.display = 'flex';
                }
                if (tabBar) tabBar.classList.add('hidden');
            } else {
                state.view = 'home';
                renderHomeNotes();
            }
            break;
    }

    if (pushState && location.hash !== '#' + tab) {
        history.pushState({ view: tab }, '', '#' + tab);
    }
}

// --- Bible Reader: Book List ---
function renderBibleBooks() {
    const container = document.getElementById('bible-book-list');
    if (!container) return;

    // Reset navigation state
    bibleReaderState = { level: 'books', bookId: null, bookName: '', chapter: null, totalChapters: 0 };
    updateBreadcrumb();

    // Show book list, hide others
    container.style.display = '';
    const chapGrid = document.getElementById('bible-chapter-grid');
    if (chapGrid) chapGrid.style.display = 'none';
    const verseView = document.getElementById('bible-verse-view');
    if (verseView) verseView.style.display = 'none';

    const otBooks = BIBLE_BOOK_INFO.filter(b => b.testament === 'ot');
    const ntBooks = BIBLE_BOOK_INFO.filter(b => b.testament === 'nt');

    container.innerHTML = `
        <div class="bible-testament-section">
            <div class="testament-title">📜 구약성경 (${otBooks.length}권)</div>
            <div class="testament-book-grid">
                ${otBooks.map(b => `<button class="bible-book-btn ot" onclick="selectBibleBook(${b.id})">${b.name}</button>`).join('')}
            </div>
        </div>
        <div class="bible-testament-section">
            <div class="testament-title">✝️ 신약성경 (${ntBooks.length}권)</div>
            <div class="testament-book-grid">
                ${ntBooks.map(b => `<button class="bible-book-btn nt" onclick="selectBibleBook(${b.id})">${b.name}</button>`).join('')}
            </div>
        </div>
    `;
}

// --- Bible Reader: Chapter Selection ---
function selectBibleBook(bookId) {
    const bookInfo = BIBLE_BOOK_INFO.find(b => b.id === bookId);
    if (!bookInfo) return;

    const totalChapters = BIBLE_CHAPTER_COUNTS[bookId - 1];
    bibleReaderState = { level: 'chapters', bookId, bookName: bookInfo.name, chapter: null, totalChapters };
    updateBreadcrumb();

    document.getElementById('bible-book-list').style.display = 'none';
    const verseView = document.getElementById('bible-verse-view');
    if (verseView) verseView.style.display = 'none';

    const grid = document.getElementById('bible-chapter-grid');
    grid.style.display = '';
    grid.innerHTML = `
        <div class="chapter-grid-header"><i class="fas fa-book-open"></i> ${bookInfo.name} (${totalChapters}장)</div>
        <div class="chapter-number-grid">
            ${Array.from({length: totalChapters}, (_, i) => i + 1).map(ch =>
                `<button class="chapter-num-btn" onclick="selectBibleChapter(${bookId}, ${ch})">${ch}</button>`
            ).join('')}
        </div>
    `;

    // Scroll to top
    const contentArea = document.getElementById('bible-content-area');
    if (contentArea) contentArea.scrollTop = 0;
}

// --- 클립보드 텍스트 복사 헬퍼 ---
function copyTextToClipboard(text, successToastMsg) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            if (successToastMsg) showToast(successToastMsg);
        }).catch(err => {
            fallbackCopyText(text, successToastMsg);
        });
    } else {
        fallbackCopyText(text, successToastMsg);
    }
}

function fallbackCopyText(text, successToastMsg) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '0';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (successful && successToastMsg) {
            showToast(successToastMsg);
        } else {
            showToast('복사되었습니다.');
        }
    } catch (err) {
        console.error('Fallback copy failed', err);
        showToast('복사하기가 지원되지 않는 환경입니다.', 'error');
    }
}

// --- Bible Reader: Verse Display (targetVerse 및 뒤로가기 버튼 지원) ---
function selectBibleChapter(bookId, chapter, targetVerse = null) {
    const bookInfo = BIBLE_BOOK_INFO.find(b => b.id === bookId);
    if (!bookInfo) return;

    const totalChapters = BIBLE_CHAPTER_COUNTS[bookId - 1];
    const versionLabel = readerVersion === 'NKRV' ? '개역개정' : '흠정역';

    bibleReaderState = {
        level: 'verses',
        bookId: bookId,
        bookName: bookInfo.name,
        chapter: chapter,
        verse: targetVerse,
        totalChapters: totalChapters
    };
    updateBreadcrumb();

    const bookList = document.getElementById('bible-book-list');
    if (bookList) bookList.style.display = 'none';
    const chapGrid = document.getElementById('bible-chapter-grid');
    if (chapGrid) chapGrid.style.display = 'none';

    const verseView = document.getElementById('bible-verse-view');
    if (!verseView) return;
    verseView.style.display = '';

    // Build verses
    let versesHtml = '';
    const data = readerVersion === 'NKRV' ? NKRV_DATA : KKJV_DATA;

    if (!data) {
        versesHtml = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">성경 데이터 로딩 중...</div>';
    } else {
        const bookIdx = bookId - 1;
        const chapIdx = chapter - 1;

        if (readerVersion === 'NKRV') {
            const bookData = data[bookIdx];
            if (bookData && bookData.chapters[chapIdx]) {
                const chapterData = bookData.chapters[chapIdx];
                chapterData.forEach((text, idx) => {
                    if (text) {
                        const verseNum = idx + 1;
                        const cleanText = text.replace(/<[^>]+>/g, '').trim();
                        const isSelected = targetVerse == verseNum;
                        versesHtml += `<div class="verse-item ${isSelected ? 'selected-verse' : ''}" data-verse="${verseNum}" id="reader-verse-${verseNum}">
                            <span class="verse-num">${verseNum}</span>
                            <span class="verse-content">${cleanText}</span>
                        </div>`;
                    }
                });
            }
        } else if (readerVersion === 'KKJV') {
            const bookData = data.books[bookIdx];
            if (bookData && bookData.chapters[chapIdx]) {
                const chapterData = bookData.chapters[chapIdx];
                chapterData.verses.forEach(v => {
                    const isSelected = targetVerse == v.verse;
                    versesHtml += `<div class="verse-item ${isSelected ? 'selected-verse' : ''}" data-verse="${v.verse}" id="reader-verse-${v.verse}">
                        <span class="verse-num">${v.verse}</span>
                        <span class="verse-content">${v.text}</span>
                    </div>`;
                });
            }
        }

        if (!versesHtml) {
            versesHtml = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">해당 장을 찾을 수 없습니다.</div>';
        }
    }

    const titleVerseStr = targetVerse ? `${targetVerse}절` : '';

    verseView.innerHTML = `
        <div class="verse-view-header">
            <button class="verse-back-to-books-btn" id="verse-back-to-books" type="button" title="성경 목록으로">
                <i class="fas fa-arrow-left"></i>
            </button>
            <div class="verse-view-title">
                <span class="verse-book-name">${bookInfo.name}</span>
                <button class="verse-nav-btn" onclick="selectBibleChapter(${bookId}, ${chapter - 1})" ${chapter <= 1 ? 'disabled' : ''} title="이전 장"><i class="fas fa-chevron-left"></i></button>
                <span class="verse-chap-name">${chapter}장</span>
                <button class="verse-nav-btn" onclick="selectBibleChapter(${bookId}, ${chapter + 1})" ${chapter >= totalChapters ? 'disabled' : ''} title="다음 장"><i class="fas fa-chevron-right"></i></button>
                <span class="verse-num-title">${titleVerseStr}</span>
                <span class="verse-version-tag">(${versionLabel})</span>
            </div>
            <button class="header-verse-copy-btn" id="header-copy-selected-btn" type="button" title="선택된 구절 복사">
                <i class="far fa-copy"></i> <span>복사</span>
            </button>
        </div>
        <div class="verse-list-container">${versesHtml}</div>
    `;

    // 성경 구절 창에서 백버튼(성경 목록으로 복귀) 바인딩
    const backToBooksBtn = document.getElementById('verse-back-to-books');
    if (backToBooksBtn) {
        backToBooksBtn.onclick = (e) => {
            e.preventDefault();
            renderBibleBooks();
        };
    }

    // 구절 클릭시 형광펜 선택 toggle 및 title 업데이트
    const listContainer = verseView.querySelector('.verse-list-container');
    if (listContainer) {
        listContainer.onclick = (e) => {
            const verseItem = e.target.closest('.verse-item');
            if (!verseItem) return;

            verseItem.classList.toggle('selected-verse');

            const selectedEls = Array.from(listContainer.querySelectorAll('.verse-item.selected-verse'));
            const selectedNums = selectedEls.map(el => parseInt(el.dataset.verse, 10)).sort((a, b) => a - b);

            if (selectedNums.length === 1) {
                bibleReaderState.verse = selectedNums[0];
            } else if (selectedNums.length > 1) {
                bibleReaderState.verse = `${selectedNums[0]}-${selectedNums[selectedNums.length - 1]}`;
            } else {
                bibleReaderState.verse = null;
            }

            const titleEl = verseView.querySelector('.verse-view-title');
            if (titleEl) {
                const verseDisplayStr = bibleReaderState.verse ? `${bibleReaderState.verse}절` : '';
                const numTitleEl = titleEl.querySelector('.verse-num-title');
                if (numTitleEl) {
                    numTitleEl.textContent = verseDisplayStr;
                }
            }
        };
    }

    // 최우측 복사 버튼 클릭시 선택된 구절 복사
    const copyHeaderBtn = document.getElementById('header-copy-selected-btn');
    if (copyHeaderBtn) {
        copyHeaderBtn.onclick = (e) => {
            e.preventDefault();
            const selectedEls = Array.from(verseView.querySelectorAll('.verse-item.selected-verse'));
            if (selectedEls.length === 0) {
                showToast && showToast('복사할 성경 구절을 선택(클릭)해주세요.', 'warning', 2500);
                return;
            }

            selectedEls.sort((a, b) => parseInt(a.dataset.verse, 10) - parseInt(b.dataset.verse, 10));
            const verseNums = selectedEls.map(el => parseInt(el.dataset.verse, 10));

            let copyText = '';
            let refStr = '';

            if (selectedEls.length === 1) {
                const vNum = verseNums[0];
                const content = selectedEls[0].querySelector('.verse-content')?.textContent.trim() || '';
                refStr = `${bookInfo.name} ${chapter}:${vNum}`;
                copyText = `${refStr} ${content}`;
            } else {
                const minV = verseNums[0];
                const maxV = verseNums[verseNums.length - 1];
                refStr = minV === maxV ? `${bookInfo.name} ${chapter}:${minV}` : `${bookInfo.name} ${chapter}:${minV}-${maxV}`;
                const lines = selectedEls.map(el => {
                    const vNum = el.dataset.verse;
                    const content = el.querySelector('.verse-content')?.textContent.trim() || '';
                    return `${vNum}. ${content}`;
                });
                copyText = `${refStr}\n` + lines.join('\n');
            }

            copyTextToClipboard(copyText, `📋 ${refStr} 말씀이 복사되었습니다!`);

            copyHeaderBtn.classList.add('copied');
            copyHeaderBtn.innerHTML = `<i class="fas fa-check"></i> <span>복사됨</span>`;
            setTimeout(() => {
                copyHeaderBtn.classList.remove('copied');
                copyHeaderBtn.innerHTML = `<i class="far fa-copy"></i> <span>복사</span>`;
            }, 1800);
        };
    }

    // Scroll to top or target verse
    const contentArea = document.getElementById('bible-content-area');
    if (targetVerse) {
        setTimeout(() => {
            const verseEl = verseView.querySelector(`.verse-item[data-verse="${targetVerse}"]`);
            if (verseEl) {
                verseEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (contentArea) {
                contentArea.scrollTop = 0;
            }
        }, 150);
    } else {
        if (contentArea) contentArea.scrollTop = 0;
    }
}

// --- Breadcrumb Navigation ---
function updateBreadcrumb() {
    const bc = document.getElementById('bible-breadcrumb');
    if (!bc) return;

    if (bibleReaderState.level === 'verses') {
        bc.style.display = 'none';
        return;
    } else {
        bc.style.display = '';
    }

    let html = `<span class="bc-item ${bibleReaderState.level === 'books' ? 'active' : ''}" onclick="renderBibleBooks()"><i class="fas fa-book"></i> 목록</span>`;

    if (bibleReaderState.level === 'chapters') {
        html += `<span class="bc-separator"><i class="fas fa-chevron-right"></i></span>`;
        html += `<span class="bc-item active" onclick="selectBibleBook(${bibleReaderState.bookId})">${bibleReaderState.bookName}</span>`;
    }

    bc.innerHTML = html;
}

// --- Bible Search ---
let searchDebounceTimer = null;

function searchBible(query) {
    const resultsContainer = document.getElementById('bible-search-results');
    const statusEl = document.getElementById('bible-search-status');
    const clearBtn = document.getElementById('search-clear-btn');

    if (!query || query.trim().length < 2) {
        if (resultsContainer) {
            resultsContainer.innerHTML = `
                <div class="search-empty-state">
                    <i class="fas fa-bible" style="font-size: 3rem; color: var(--accent-primary); opacity: 0.3; margin-bottom: 1rem;"></i>
                    <p>성경 말씀을 검색해보세요</p>
                    <p style="font-size: 0.8rem; color: var(--text-muted);">2글자 이상 입력해주세요</p>
                </div>
            `;
        }
        if (statusEl) statusEl.style.display = 'none';
        if (clearBtn) clearBtn.style.display = query ? '' : 'none';
        return;
    }

    if (clearBtn) clearBtn.style.display = '';

    const data = searchVersion === 'NKRV' ? NKRV_DATA : KKJV_DATA;
    if (!data) {
        if (resultsContainer) resultsContainer.innerHTML = '<div class="search-empty-state"><p>성경 데이터 로딩 중입니다...</p></div>';
        return;
    }

    // Show loading
    if (resultsContainer) resultsContainer.innerHTML = '<div class="search-loading"><i class="fas fa-spinner"></i> 검색 중...</div>';

    // Use setTimeout for non-blocking search
    setTimeout(() => {
        const results = [];
        const queryLower = query.trim().toLowerCase();
        const maxResults = 200;

        if (searchVersion === 'NKRV') {
            for (let bookIdx = 0; bookIdx < data.length && results.length < maxResults; bookIdx++) {
                const book = data[bookIdx];
                if (!book || !book.chapters) continue;
                const bookInfo = BIBLE_BOOK_INFO[bookIdx];
                if (!bookInfo) continue;

                for (let chapIdx = 0; chapIdx < book.chapters.length && results.length < maxResults; chapIdx++) {
                    const chapter = book.chapters[chapIdx];
                    if (!chapter) continue;

                    for (let vIdx = 0; vIdx < chapter.length && results.length < maxResults; vIdx++) {
                        const verseText = (chapter[vIdx] || '').replace(/<[^>]+>/g, '').trim();
                        if (verseText.toLowerCase().includes(queryLower)) {
                            results.push({
                                bookId: bookInfo.id,
                                bookName: bookInfo.name,
                                chapter: chapIdx + 1,
                                verse: vIdx + 1,
                                text: verseText
                            });
                        }
                    }
                }
            }
        } else if (searchVersion === 'KKJV' && data.books) {
            for (let bookIdx = 0; bookIdx < data.books.length && results.length < maxResults; bookIdx++) {
                const book = data.books[bookIdx];
                if (!book || !book.chapters) continue;
                const bookInfo = BIBLE_BOOK_INFO[bookIdx];
                if (!bookInfo) continue;

                for (let chapIdx = 0; chapIdx < book.chapters.length && results.length < maxResults; chapIdx++) {
                    const chap = book.chapters[chapIdx];
                    if (!chap || !chap.verses) continue;

                    for (let vIdx = 0; vIdx < chap.verses.length && results.length < maxResults; vIdx++) {
                        const v = chap.verses[vIdx];
                        if (v && v.text && v.text.toLowerCase().includes(queryLower)) {
                            results.push({
                                bookId: bookInfo.id,
                                bookName: bookInfo.name,
                                chapter: chapIdx + 1,
                                verse: v.verse,
                                text: v.text
                            });
                        }
                    }
                }
            }
        }

        // Render results
        const versionLabel = searchVersion === 'NKRV' ? '개역개정' : '흠정역';
        if (statusEl) {
            statusEl.style.display = '';
            statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:var(--accent-primary);margin-right:4px;"></i> "${query}" 검색 결과: <strong>${results.length}</strong>건 (${versionLabel})${results.length >= maxResults ? ' <span style="color:#f59e0b;">(최대 표시)</span>' : ''}`;
        }

        if (results.length === 0) {
            if (resultsContainer) {
                resultsContainer.innerHTML = `
                    <div class="search-empty-state">
                        <i class="fas fa-search" style="font-size: 2.5rem; color: var(--text-muted); opacity: 0.3; margin-bottom: 1rem;"></i>
                        <p>"${query}"에 대한 검색 결과가 없습니다</p>
                    </div>
                `;
            }
            return;
        }

        // Escape special regex chars in query for highlighting
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const highlightRegex = new RegExp(`(${escapedQuery})`, 'gi');

        if (resultsContainer) {
            resultsContainer.innerHTML = results.map(r => {
                const highlighted = r.text.replace(highlightRegex, '<mark>$1</mark>');
                const safeText = r.text.replace(/"/g, '&quot;');
                const ref = `${r.bookName} ${r.chapter}:${r.verse}`;
                return `
                    <div class="search-result-card" data-ref="${ref}" data-text="${safeText}">
                        <div class="search-result-header" style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                            <div class="search-result-ref" onclick="goToSearchResult(${r.bookId}, ${r.chapter})"><i class="fas fa-bookmark"></i> ${ref}</div>
                            <button class="verse-copy-btn search-copy-btn" type="button" title="구절 복사"><i class="far fa-copy"></i> <span>복사</span></button>
                        </div>
                        <div class="search-result-text" onclick="goToSearchResult(${r.bookId}, ${r.chapter})">${highlighted}</div>
                    </div>
                `;
            }).join('');

            resultsContainer.querySelectorAll('.search-copy-btn').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const card = btn.closest('.search-result-card');
                    if (!card) return;
                    const ref = card.dataset.ref;
                    const text = card.dataset.text;
                    copyTextToClipboard(`${ref} ${text}`, `📋 ${ref} 말씀이 복사되었습니다!`);
                    btn.classList.add('copied');
                    btn.innerHTML = `<i class="fas fa-check"></i> <span>복사됨</span>`;
                    setTimeout(() => {
                        btn.classList.remove('copied');
                        btn.innerHTML = `<i class="far fa-copy"></i> <span>복사</span>`;
                    }, 1800);
                };
            });
        }
    }, 50);
}

function goToSearchResult(bookId, chapter) {
    // Switch to bible tab and show the chapter
    switchTab('bible');
    readerVersion = searchVersion; // Use same version
    syncReaderVersionUI();
    selectBibleBook(bookId);
    setTimeout(() => selectBibleChapter(bookId, chapter), 100);
}

function syncReaderVersionUI() {
    document.querySelectorAll('#reader-version-toggle .rv-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.version === readerVersion);
    });
}

function syncSearchVersionUI() {
    document.querySelectorAll('#search-version-toggle .rv-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.version === searchVersion);
    });
}


// --- Init Tab System ---
document.addEventListener('DOMContentLoaded', () => {
    // Tab button clicks
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });

    // Reader version toggle
    document.querySelectorAll('#reader-version-toggle .rv-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            readerVersion = btn.dataset.version;
            syncReaderVersionUI();
            // Refresh current view
            if (bibleReaderState.level === 'verses' && bibleReaderState.bookId && bibleReaderState.chapter) {
                selectBibleChapter(bibleReaderState.bookId, bibleReaderState.chapter);
            }
        });
    });

    // Search version toggle
    document.querySelectorAll('#search-version-toggle .rv-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            searchVersion = btn.dataset.version;
            syncSearchVersionUI();
            // Re-search if there's a query
            const input = document.getElementById('bible-search-input');
            if (input && input.value.trim().length >= 2) {
                searchBible(input.value);
            }
        });
    });

    // Search input
    const searchInput = document.getElementById('bible-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                searchBible(e.target.value);
            }, 400);
        });
    }

    // Search clear button
    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            const input = document.getElementById('bible-search-input');
            if (input) {
                input.value = '';
                input.focus();
            }
            clearBtn.style.display = 'none';
            const resultsContainer = document.getElementById('bible-search-results');
            if (resultsContainer) {
                resultsContainer.innerHTML = `
                    <div class="search-empty-state">
                        <i class="fas fa-bible" style="font-size: 3rem; color: var(--accent-primary); opacity: 0.3; margin-bottom: 1rem;"></i>
                        <p>성경 말씀을 검색해보세요</p>
                        <p style="font-size: 0.8rem; color: var(--text-muted);">개역개정 또는 흠정역에서 키워드로 검색합니다</p>
                    </div>
                `;
            }
            const statusEl = document.getElementById('bible-search-status');
            if (statusEl) statusEl.style.display = 'none';
        });
    }

    // Bible quick jump init (약어 검색 바인딩)
    initBibleQuickJump();

    // 메인 설교노트 토글 바인딩
    initHomeSermonNotesToggle();

    // Ensure main home (faith card) is shown by default
    showMainHome(false);
});

// --- 설교노트 리스트 바로 들어가기 ---
function openSermonNotesList() {
    state.view = 'home';
    state.currentNoteId = null;
    switchTab('sermon');
    const area = document.getElementById('home-content-area');
    if (area) {
        area.style.display = 'block';
    }
    const heroCard = document.getElementById('home-hero-card');
    if (heroCard) {
        heroCard.style.display = 'none';
    }
    const sermonToMainBtn = document.getElementById('sermon-to-main-btn');
    if (sermonToMainBtn) {
        sermonToMainBtn.style.display = 'inline-flex';
    }
    const homeView = document.getElementById('home-view');
    if (homeView) {
        homeView.classList.add('show-notes-list');
    }
    renderHomeNotes();
}

// --- 메인 설교노트 목록 숨김/열기 토글 (요구사항) ---
function toggleHomeNotesList(forceState = null) {
    const area = document.getElementById('home-content-area');
    const arrow = document.getElementById('notes-toggle-arrow');
    if (!area) return;

    let shouldShow = forceState !== null ? forceState : (area.style.display === 'none');
    if (shouldShow) {
        area.style.display = 'block';
        if (arrow) arrow.className = 'fas fa-chevron-down';
        setTimeout(() => {
            area.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    } else {
        area.style.display = 'none';
        if (arrow) arrow.className = 'fas fa-chevron-right';
    }
}

function initHomeSermonNotesToggle() {
    const openCard = document.getElementById('btn-open-sermon-notes-card');
    const createCard = document.getElementById('btn-create-note-card');
    const closeBtn = document.getElementById('btn-close-notes-list');

    if (openCard && !openCard._bound) {
        openCard._bound = true;
        openCard.onclick = (e) => {
            e.preventDefault();
            openSermonNotesList();
        };
    }

    if (createCard && !createCard._bound) {
        createCard._bound = true;
        createCard.onclick = (e) => {
            e.preventDefault();
            openNoteMetaModal('create');
        };
    }

    if (closeBtn && !closeBtn._bound) {
        closeBtn._bound = true;
        closeBtn.onclick = (e) => {
            e.preventDefault();
            showMainHome();
        };
    }

    // 메인 말씀카드 요약 칩 (총 노트, 이번달 노트, 최근 노트, 연속 동행) 클릭 시 설교노트 리스트로 바로 전환
    const chips = ['summary-visit-chip', 'summary-total-chip', 'summary-month-chip', 'summary-latest-note-chip'];
    chips.forEach(chipId => {
        const chip = document.getElementById(chipId);
        if (chip && !chip._bound) {
            chip._bound = true;
            chip.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openSermonNotesList();
            };
        }
    });
}
