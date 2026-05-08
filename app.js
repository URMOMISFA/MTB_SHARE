const screenTitles = {
  home: "Upload Feed",
  map: "Trail Map",
  videos: "Video Feed",
  post: "Create",
  clubs: "Ride Crews",
  analytics: "Creator Stats",
  profile: "Profile",
};

let activeFeed = "all";
let posts = [];
let clubs = [];
let videos = [];
let analytics = null;
let currentUser = null;
let toastTimer;
let activeCommentPostId = null;
const viewedVideos = new Set();

const feedList = document.querySelector("#feedList");
const clubList = document.querySelector("#clubList");
const videoFeed = document.querySelector("#videoFeed");
const analyticsPanel = document.querySelector("#analyticsPanel");
const screenTitle = document.querySelector("#screenTitle");
const composerDialog = document.querySelector("#composerDialog");
const composerForm = document.querySelector("#composerForm");
const authDialog = document.querySelector("#authDialog");
const authForm = document.querySelector("#authForm");
const commentDialog = document.querySelector("#commentDialog");
const commentForm = document.querySelector("#commentForm");
const postType = document.querySelector("#postType");
const postText = document.querySelector("#postText");
const postTrail = document.querySelector("#postTrail");
const postPace = document.querySelector("#postPace");
const postMedia = document.querySelector("#postMedia");
const commentText = document.querySelector("#commentText");
const toast = document.querySelector("#toast");

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

async function boot() {
  try {
    const session = await api("/api/me");
    currentUser = session.user;
    await Promise.all([loadPosts(), loadClubs(), loadVideos(), loadAnalytics()]);
    updateProfile();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadPosts() {
  const type = activeFeed === "all" ? "all" : activeFeed.slice(0, -1);
  const payload = await api(`/api/posts?type=${encodeURIComponent(type)}`);
  posts = payload.posts;
  renderFeed();
}

async function loadClubs() {
  const payload = await api("/api/clubs");
  clubs = payload.clubs;
  renderClubs();
}

async function loadVideos() {
  const payload = await api("/api/videos");
  videos = payload.videos;
  renderVideos();
}

async function loadAnalytics() {
  const payload = await api("/api/analytics");
  analytics = payload.analytics;
  renderAnalytics();
}

function renderFeed() {
  if (!posts.length) {
    feedList.innerHTML = `
      <article class="empty-state glass">
        <div class="empty-device">
          <span></span>
        </div>
        <div>
          <p class="kicker">Empty Feed</p>
          <h2>Upload the first real ride.</h2>
          <p>Photos and videos posted by users will appear here with likes, comments, and ride requests.</p>
          <button class="primary-button" type="button" data-compose-type="video">Choose Media</button>
        </div>
      </article>
    `;
    return;
  }

  feedList.innerHTML = posts.map(renderPost).join("");
}

function renderPost(post) {
  const author = post.author || {};
  const media = renderPostMedia(post.media);
  const comments = post.comments.slice(-2).map((comment) => {
    const name = comment.author ? comment.author.name : "Rider";
    return `<li><strong>${escapeHtml(name)}:</strong> ${escapeHtml(comment.text)}</li>`;
  });
  const commentsMarkup = comments.length ? `<ul class="comment-list">${comments.join("")}</ul>` : "";
  const joinLabel = post.type === "ride" ? (post.requested ? "Requested" : "Join") : escapeHtml(post.pace);

  return `
    <article class="post-card glass" data-post-id="${post.id}">
      <div class="post-meta">
        <div class="rider-avatar ${escapeHtml(author.avatar || "blue")}">${escapeHtml(author.initials || "--")}</div>
        <div>
          <h2>${escapeHtml(author.name || "Rider")}</h2>
          <p>${escapeHtml(typeLabel(post.type))} - ${escapeHtml(post.trail)} - ${timeAgo(post.createdAt)}</p>
        </div>
        <button class="pill-button" type="button" data-action="${post.type === "ride" ? "request" : "tag"}">${joinLabel}</button>
      </div>
      ${media}
      <p class="post-copy">${escapeHtml(post.text)}</p>
      ${commentsMarkup}
      <div class="action-row">
        <button type="button" data-action="props">${post.reacted ? "Propped" : "Props"} (${post.reactionCount})</button>
        <button type="button" data-action="comment">Comment (${post.commentCount})</button>
        <button type="button" data-action="share">Share route</button>
      </div>
    </article>
  `;
}

function renderPostMedia(media) {
  if (!media || !media.url) return "";
  if (media.kind === "video") {
    return `<video class="uploaded-media" src="${escapeHtml(media.url)}" controls playsinline preload="metadata"></video>`;
  }
  return `<img class="uploaded-media" src="${escapeHtml(media.url)}" alt="Uploaded ride media" loading="lazy" />`;
}

function renderClubs() {
  clubList.innerHTML = clubs.map((club) => `
    <article class="club-card glass" data-club-id="${club.id}">
      <div>
        <p class="kicker">${escapeHtml(club.kind)}</p>
        <h2>${escapeHtml(club.name)}</h2>
        <p>${club.memberCount} riders. ${escapeHtml(club.description)}</p>
      </div>
      <button class="pill-button" type="button" data-club-join="${club.id}">${club.joined ? "Joined" : "Join"}</button>
    </article>
  `).join("");
}

function renderVideos() {
  if (!videos.length) {
    videoFeed.innerHTML = `
      <article class="empty-video glass">
        <div class="empty-device tall">
          <span></span>
        </div>
        <div>
          <p class="kicker">Video Feed</p>
          <h2>No videos uploaded yet.</h2>
          <p>The TikTok-style feed starts once riders upload real video files.</p>
          <div class="video-counts"><span>0 likes</span><span>0 views</span></div>
          <button class="primary-button" type="button" data-compose-type="video">Upload Video</button>
        </div>
      </article>
    `;
    return;
  }
  videoFeed.innerHTML = videos.map((video) => `
    <article class="video-card ${escapeHtml(video.palette)} ${video.media ? "has-media" : ""}" data-video-id="${video.id}">
      ${renderVideoMedia(video.media)}
      <div class="video-overlay">
        <div class="video-description">
          <p class="kicker">${escapeHtml(video.author ? video.author.handle : "rider")} - ${escapeHtml(video.trail)} - ${escapeHtml(video.duration)}</p>
          <h2>${escapeHtml(video.title)}</h2>
          <p>${escapeHtml(video.description)}</p>
          <div class="video-counts" aria-label="Video like and view count">
            <span>${formatCount(video.likeCount)} likes</span>
            <span>${formatCount(video.views)} views</span>
          </div>
        </div>
        <div class="video-actions">
          <button type="button" data-video-action="like"><strong>${video.liked ? "Liked" : "Like"}</strong>${formatCount(video.likeCount)}</button>
          <button type="button" data-video-action="view"><strong>View</strong>${formatCount(video.views)}</button>
        </div>
      </div>
    </article>
  `).join("");
  watchVideoViews();
}

function renderVideoMedia(media) {
  if (!media || !media.url) return "";
  return `<video class="video-media" src="${escapeHtml(media.url)}" playsinline controls preload="metadata"></video>`;
}

function renderAnalytics() {
  if (!analytics) return;
  const rows = analytics.videos.length
    ? analytics.videos.map((video) => `
        <div class="analytics-row">
          <div>
            <strong>${escapeHtml(video.title)}</strong>
            <p>${escapeHtml(video.trail)} - ${formatCount(video.likes)} likes - ${formatCount(video.views)} views</p>
          </div>
          <strong>${video.engagementRate}%</strong>
        </div>
      `).join("")
    : `<div class="analytics-row"><div><strong>No videos yet</strong><p>Upload a video to start collecting creator analytics.</p></div><strong>0%</strong></div>`;
  analyticsPanel.innerHTML = `
    <article class="analytics-card glass">
      <div>
        <p class="kicker">${escapeHtml(analytics.scope)}</p>
        <h2>Creator video analytics</h2>
        <p>Track performance for MTB Share short-form riding videos.</p>
      </div>
      <div class="analytics-grid">
        <div class="analytics-stat"><strong>${formatCount(analytics.totals.videos)}</strong>Videos</div>
        <div class="analytics-stat"><strong>${formatCount(analytics.totals.views)}</strong>Views</div>
        <div class="analytics-stat"><strong>${formatCount(analytics.totals.likes)}</strong>Likes</div>
        <div class="analytics-stat"><strong>${analytics.totals.engagementRate}%</strong>Like rate</div>
      </div>
    </article>
    <article class="analytics-card glass">
      <div>
        <p class="kicker">Top Videos</p>
        <h2>Performance by post</h2>
      </div>
      <div class="analytics-list">
        ${rows}
      </div>
    </article>
  `;
}

function updateProfile() {
  const initials = currentUser ? currentUser.initials : "--";
  document.querySelector("#topAvatar").textContent = initials;
  document.querySelector("#quickAvatar").textContent = initials;
  document.querySelector("#profileAvatar").textContent = initials;
  document.querySelector("#profileName").textContent = currentUser ? currentUser.name : "Sign in";
  document.querySelector("#profileBio").textContent = currentUser
    ? `${currentUser.bio} @${currentUser.handle}`
    : "Create an account to post, request rides, comment, and join crews.";
  document.querySelector("#profileMiles").textContent = currentUser ? currentUser.stats.miles : "0";
  document.querySelector("#profileRides").textContent = currentUser ? currentUser.stats.rides : "0";
  document.querySelector("#profilePeers").textContent = currentUser ? clubs.filter((club) => club.joined).length : "0";
  document.querySelector("#authButton").textContent = currentUser ? "Edit Ride Profile" : "Sign In or Join";
  document.querySelector("#logoutButton").hidden = !currentUser;
}

function watchVideoViews() {
  if (!("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(async (entry) => {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.65) return;
      const id = entry.target.dataset.videoId;
      if (viewedVideos.has(id)) return;
      viewedVideos.add(id);
      try {
        await api(`/api/videos/${id}/view`, { method: "POST", body: "{}" });
        await Promise.all([loadVideos(), loadAnalytics()]);
      } catch {
        // View counts are best-effort so scrolling never feels blocked.
      }
    });
  }, { threshold: [0.65] });

  document.querySelectorAll("[data-video-id]").forEach((card) => observer.observe(card));
}

function setScreen(screen) {
  document.querySelectorAll(".screen").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${screen}Screen`);
  });
  document.querySelectorAll("[data-screen]").forEach((button) => {
    button.classList.toggle("active", button.dataset.screen === screen);
  });
  screenTitle.textContent = screenTitles[screen] || "MTB Share";
}

function openComposer(type = "ride") {
  if (!currentUser) {
    openDialog(authDialog);
    return;
  }
  postType.value = type;
  if (type === "report") {
    postText.value = "Trail is running fast today. Add condition details for other riders.";
    postPace.value = "Condition";
  } else if (type === "route") {
    postText.value = "Dropping a route with punchy climbs and clean descents.";
    postPace.value = "Mixed";
  } else if (type === "video") {
    postText.value = "Fresh ride clip from today's lap.";
    postPace.value = "Media";
  } else {
    postText.value = "Rolling from the west lot at 6:15. Who wants a no-drop lap?";
    postPace.value = "Moderate";
  }
  postMedia.value = "";
  openDialog(composerDialog);
}

function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function typeLabel(type) {
  if (type === "video") return "Media upload";
  if (type === "report") return "Trail report";
  if (type === "route") return "Route drop";
  return "Ride invite";
}

function timeAgo(timestamp) {
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatCount(value) {
  const number = Number(value || 0);
  if (number >= 1000000) return `${Math.round(number / 100000) / 10}M`;
  if (number >= 1000) return `${Math.round(number / 100) / 10}K`;
  return String(number);
}

function readSelectedMedia() {
  const file = postMedia.files && postMedia.files[0];
  if (!file) return Promise.resolve(null);
  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
    return Promise.reject(new Error("Choose a photo or video file"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result });
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}

document.querySelectorAll("[data-screen]").forEach((button) => {
  button.addEventListener("click", () => setScreen(button.dataset.screen));
});

document.querySelectorAll("[data-feed]").forEach((button) => {
  button.addEventListener("click", async () => {
    activeFeed = button.dataset.feed;
    document.querySelectorAll("[data-feed]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    await loadPosts();
  });
});

document.querySelector("#openComposer").addEventListener("click", () => openComposer("ride"));
document.querySelector("#liveRideButton").addEventListener("click", () => showToast(currentUser ? "Live ride ping broadcast" : "Sign in to start a live ride"));
document.querySelector("#notifyButton").addEventListener("click", () => showToast("Notifications are ready for ride requests and comments"));
document.querySelector("#authButton").addEventListener("click", () => openDialog(authDialog));
document.querySelector("#logoutButton").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  currentUser = null;
  await Promise.all([loadPosts(), loadClubs(), loadVideos(), loadAnalytics()]);
  updateProfile();
  showToast("Logged out");
});

document.querySelectorAll("[data-compose-type]").forEach((button) => {
  button.addEventListener("click", () => openComposer(button.dataset.composeType));
});

document.body.addEventListener("click", async (event) => {
  const videoAction = event.target.closest("[data-video-action]");
  if (videoAction) {
    const card = videoAction.closest("[data-video-id]");
    const videoId = card.dataset.videoId;
    try {
      if (videoAction.dataset.videoAction === "like") {
        await api(`/api/videos/${videoId}/like`, { method: "POST", body: "{}" });
        showToast("Video like updated");
      } else {
        await api(`/api/videos/${videoId}/view`, { method: "POST", body: "{}" });
        showToast("View counted");
      }
      await Promise.all([loadVideos(), loadAnalytics()]);
    } catch (error) {
      if (error.message === "Sign in required") openDialog(authDialog);
      else showToast(error.message);
    }
    return;
  }

  const clubJoin = event.target.closest("[data-club-join]");
  if (clubJoin) {
    if (!currentUser) return openDialog(authDialog);
    await api(`/api/clubs/${clubJoin.dataset.clubJoin}/join`, { method: "POST", body: "{}" });
    await loadClubs();
    updateProfile();
    showToast("Crew joined");
    return;
  }

  const target = event.target.closest("[data-toast], [data-action]");
  if (!target) return;

  if (target.dataset.toast) {
    showToast(target.dataset.toast);
    return;
  }

  const post = target.closest("[data-post-id]");
  if (!post) return;
  const postId = post.dataset.postId;

  try {
    if (target.dataset.action === "props") {
      await api(`/api/posts/${postId}/react`, { method: "POST", body: "{}" });
      await loadPosts();
      showToast("Props updated");
    } else if (target.dataset.action === "comment") {
      if (!currentUser) return openDialog(authDialog);
      activeCommentPostId = postId;
      openDialog(commentDialog);
    } else if (target.dataset.action === "request") {
      await api(`/api/posts/${postId}/request`, { method: "POST", body: "{}" });
      await loadPosts();
      showToast("Ride request sent");
    } else if (target.dataset.action === "share") {
      await navigator.clipboard?.writeText(`${location.origin}/#post-${postId}`);
      showToast("Route link copied");
    }
  } catch (error) {
    if (error.message === "Sign in required") openDialog(authDialog);
    else showToast(error.message);
  }
});

composerForm.addEventListener("submit", async (event) => {
  const submitter = event.submitter || document.activeElement;
  if (submitter && submitter.value !== "post") return;
  event.preventDefault();

  try {
    await api("/api/posts", {
      method: "POST",
      body: JSON.stringify({
        type: postType.value,
        text: postText.value.trim(),
        trail: postTrail.value.trim(),
        pace: postPace.value.trim(),
        title: postTrail.value.trim(),
        media: await readSelectedMedia(),
      }),
    });
    await Promise.all([loadPosts(), loadVideos(), loadAnalytics()]);
    closeDialog(composerDialog);
    setScreen("home");
    showToast("Posted to MTB Share");
  } catch (error) {
    showToast(error.message);
  }
});

authForm.addEventListener("submit", async (event) => {
  const submitter = event.submitter || document.activeElement;
  if (!submitter || submitter.value === "cancel") return;
  event.preventDefault();

  try {
    const endpoint = submitter.value === "login" ? "/api/auth/login" : "/api/auth/signup";
    const payload = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({
        name: document.querySelector("#authName").value.trim(),
        handle: document.querySelector("#authHandle").value.trim(),
        password: document.querySelector("#authPassword").value,
      }),
    });
    currentUser = payload.user;
    await Promise.all([loadPosts(), loadClubs(), loadVideos(), loadAnalytics()]);
    updateProfile();
    closeDialog(authDialog);
    showToast(`Welcome, ${currentUser.name}`);
  } catch (error) {
    showToast(error.message);
  }
});

commentForm.addEventListener("submit", async (event) => {
  const submitter = event.submitter || document.activeElement;
  if (!submitter || submitter.value !== "comment") return;
  event.preventDefault();

  try {
    await api(`/api/posts/${activeCommentPostId}/comments`, {
      method: "POST",
      body: JSON.stringify({ text: commentText.value.trim() }),
    });
    await loadPosts();
    closeDialog(commentDialog);
    showToast("Comment posted");
  } catch (error) {
    showToast(error.message);
  }
});

boot();
setScreen("home");

if ("serviceWorker" in navigator && window.location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
