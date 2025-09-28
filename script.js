// --- START OF FILE script.js ---

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const connectBtn = document.getElementById('connectBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const storyblokTokenInput = document.getElementById('storyblokToken');
    const toggleTokenVisibilityBtn = document.getElementById('toggleTokenVisibility');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const storyList = document.getElementById('storyList');
    const loadingIndicatorSidebar = document.getElementById('loadingIndicatorSidebar');
    const loadingIndicatorMain = document.getElementById('loadingIndicatorMain');
    const currentStoryTitle = document.getElementById('currentStoryTitle');
    const imageTable = document.getElementById('imageTable');
    const imageTableBody = imageTable.querySelector('tbody');
    const toggleEditBtn = document.getElementById('toggleEditBtn');
    const sendToServerBtn = document.getElementById('sendToServerBtn');
    const modalOverlay = document.getElementById('modalOverlay');
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const modalCloseBtn = document.getElementById('modalCloseBtn');

    // Constants
    const STORYBLOK_SPACE_ID = '103684';
    const BASE_MAPI_URL = `https://mapi.storyblok.com/v1/spaces/${STORYBLOK_SPACE_ID}`;
    const STORYBLOK_APP_URL = `https://app.storyblok.com/#/me/spaces/${STORYBLOK_SPACE_ID}/stories/0/0`;
    const DAMEN_WEBSITE_BASE_URL = 'https://www.damen.com';
    const STORYBLOK_TOKEN_KEY = 'storyblokMapiToken';

    // Global state
    let storyblokMapiToken = localStorage.getItem(STORYBLOK_TOKEN_KEY) || '';
    let allStories = []; // Stores { name, id, slug, full_slug }
    let currentStoryData = null; // Stores the full JSON data of the currently selected story
    let currentStoryImages = []; // Stores extracted image data for the current story and sub-story
    let isEditMode = false;
    let modifiedImages = new Map(); // Map<imageId, {altText: string, fileName: string, originalBynderImageRef: object, originalParentField: string, originalStoryId: number}>


    toggleEditBtn.disabled = false;
    isEditMode = false; // Reset edit mode
    toggleEditBtn.textContent = 'Toggle Edit Mode';


    // --- Utility Functions ---

    /**
     * Shows a custom modal dialog with a title and message.
     * @param {string} title
     * @param {string} message
     */
    function showModal(title, message, autoclose) {
        modalTitle.textContent = title;
        modalMessage.textContent = message;
        modalOverlay.classList.remove('hidden');
		
		// Добавляем эту строку, чтобы скрыть модальное окно через 1 секунду
		if (autoclose) {
			setTimeout(() => {
				modalOverlay.classList.add('hidden');
			}, 1000);
		}
    }

    /**
     * Hides the custom modal dialog.
     */
    function hideModal() {
        modalOverlay.classList.add('hidden');
    }

    /**
     * Toggles the visibility of a loading indicator.
     * @param {HTMLElement} indicatorElement
     * @param {boolean} show
     */
    function toggleLoadingIndicator(indicatorElement, show) {
        if (show) {
            indicatorElement.classList.remove('hidden');
        } else {
            indicatorElement.classList.add('hidden');
        }
    }

    /**
     * Makes an authenticated API request to Storyblok.
     * @param {string} url - The API endpoint URL.
     * @param {string} method - HTTP method (GET, POST, PUT, etc.).
     * @param {object} [body=null] - Request body for POST/PUT requests.
     * @returns {Promise<object>} - JSON response from the API.
     * @throws {Error} - If the token is missing or API request fails.
     */
    async function makeApiRequest(url, method = 'GET', body = null) {
        if (!storyblokMapiToken) {
            throw new Error('Storyblok MAPI token is not set. Please go to Settings.');
        }

        const options = {
            method: method,
            headers: {
                'Authorization': storyblokMapiToken,
                'Content-Type': 'application/json'
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`API Error: ${response.status} - ${errorData.error || response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            console.error('API Request failed:', error);
            throw new Error(`Failed to fetch data from Storyblok: ${error.message}`);
        }
    }

    /**
     * Recursively finds image objects within a Storyblok content object.
     * @param {object} content - The Storyblok content object.
     * @param {string} parentField - The name of the field containing the images (e.g., 'images3D', 'og_image').
     * @returns {Array<object>} An array of objects, each containing an image object and its parent field name.
     */
    function findImagesInContent(content, parentField = 'root') {
        let images = [];

        if (Array.isArray(content)) {
            content.forEach(item => {
                images = images.concat(findImagesInContent(item, parentField));
            });
        } else if (typeof content === 'object' && content !== null) {
            for (const key in content) {
                if (content.hasOwnProperty(key)) {
                    // Check if the current key directly holds an image array
                    if (Array.isArray(content[key]) && content[key].length > 0 && content[key][0].component === 'bynder_image') {
                        content[key].forEach(imageWrapper => {
                            if (imageWrapper.image && Array.isArray(imageWrapper.image) && imageWrapper.image.length > 0 && imageWrapper.image[0].databaseId) {
                                images.push({
                                    bynderImage: imageWrapper.image[0],
                                    alt: imageWrapper.alt,
                                    parentField: key, // The field name directly containing the bynder_image component
                                    _uid: imageWrapper._uid // Store _uid to help identify the exact object later
                                });
                            }
                        });
                    } else if (typeof content[key] === 'object' && content[key] !== null) {
                        // Recursively search in nested objects/arrays
                        images = images.concat(findImagesInContent(content[key], key));
                    }
                }
            }
        }
        return images;
    }

    /**
     * Extracts all relevant image data from a Storyblok story JSON.
     * This function now returns both the extracted images and a reference to the modified JSON
     * so it can be updated later.
     * @param {object} storyJson - The full Storyblok story JSON.
     * @param {number} storyId - The ID of the story this JSON belongs to (for PUT requests).
     * @returns {Array<object>} An array of structured image objects.
     */
    function extractImagesFromStoryJson(storyJson, storyId) {
        const extractedImages = [];
        const content = storyJson.story.content;

        // Use a helper function to recursively find and collect image data
        function collectImagesRecursive(obj, currentPath = '') {
            if (typeof obj !== 'object' || obj === null) {
                return;
            }

            if (Array.isArray(obj)) {
                obj.forEach((item, index) => {
                    collectImagesRecursive(item, `${currentPath}[${index}]`);
                });
            } else {
                for (const key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        const newPath = currentPath ? `${currentPath}.${key}` : key;

                        // Check for bynder_image component
                        if (Array.isArray(obj[key]) && obj[key].length > 0 && obj[key][0] && obj[key][0].component === 'bynder_image') {
                            obj[key].forEach(imageWrapper => {
                                if (imageWrapper.image && Array.isArray(imageWrapper.image) && imageWrapper.image.length > 0 && imageWrapper.image[0].databaseId) {
                                    extractedImages.push({
                                        storyId: storyId,
                                        parentField: key,
                                        alt: imageWrapper.alt || '',
                                        fileName: imageWrapper.image[0].name || '',
                                        bynderId: imageWrapper.image[0].databaseId,
                                        thumbnailUrl: imageWrapper.image[0].files.thumbnail.url,
                                        transformUrl: imageWrapper.image[0].files.transformBaseUrl.url,
                                        _uid: imageWrapper._uid, // Unique ID for this specific imageWrapper object
                                        bynderImageRef: imageWrapper.image[0], // Reference to the actual bynder image object
                                        altTextRef: imageWrapper // Reference to the parent object containing 'alt'
                                    });
                                }
                            });
                        }
                        // Recurse for other nested objects/arrays
                        collectImagesRecursive(obj[key], newPath);
                    }
                }
            }
        }

        collectImagesRecursive(content);
        return extractedImages;
    }

    /**
     * Renders the image table body with current image data.
     * @param {Array<object>} images - Array of structured image objects.
     */
    function renderImageTable(images) {
        imageTableBody.innerHTML = ''; // Clear existing rows
        if (images.length === 0) {
            imageTableBody.innerHTML = '<tr><td colspan="5" class="table-placeholder">No images found for this story.</td></tr>';
            sendToServerBtn.disabled = true;
            return;
        }

        const fragment = document.createDocumentFragment();
        images.forEach(image => {
            const row = document.createElement('tr');

            // Image Thumbnail column
            const imgTd = document.createElement('td');
            const imgLink = document.createElement('a');
            imgLink.href = image.transformUrl;
            imgLink.target = '_blank';
            const imgThumbnail = document.createElement('img');
            imgThumbnail.src = image.thumbnailUrl;
            imgThumbnail.alt = image.alt; // Use alt for the thumbnail itself
            imgThumbnail.className = 'img-thumbnail';
            imgLink.appendChild(imgThumbnail);
            imgTd.appendChild(imgLink);
            row.appendChild(imgTd);

            // Bynder Link column
            const bynderLinkTd = document.createElement('td');
            const bynderLink = document.createElement('a');
            bynderLink.href = `https://medialibrary.damen.com/media/?mediaId=${image.bynderId}`;
            bynderLink.target = '_blank';
            bynderLink.textContent = 'link';
            bynderLinkTd.appendChild(bynderLink);
            row.appendChild(bynderLinkTd);

            // Parent Field column
            const parentFieldTd = document.createElement('td');
            parentFieldTd.textContent = image.parentField;
            row.appendChild(parentFieldTd);

            // File Name column
            const fileNameTd = document.createElement('td');
            const fileNameInput = document.createElement('textarea');
            fileNameInput.className = `editable-cell ${isEditMode ? 'editable' : ''}`;
            fileNameInput.readOnly = !isEditMode;
            fileNameInput.value = image.fileName;
            fileNameInput.dataset.storyId = image.storyId;
            fileNameInput.dataset.uid = image._uid;
            fileNameInput.dataset.field = 'fileName';
            fileNameTd.appendChild(fileNameInput);
            row.appendChild(fileNameTd);

            // ALT Text column
            const altTextTd = document.createElement('td');
            const altTextInput = document.createElement('textarea');
            altTextInput.className = `editable-cell ${isEditMode ? 'editable' : ''}`;
            altTextInput.readOnly = !isEditMode;
            altTextInput.value = image.alt;
            altTextInput.dataset.storyId = image.storyId;
            altTextInput.dataset.uid = image._uid;
            altTextInput.dataset.field = 'altText';
            altTextTd.appendChild(altTextInput);
            row.appendChild(altTextTd);

            fragment.appendChild(row);
        });
        imageTableBody.appendChild(fragment);

        // Re-attach event listeners for editable cells if in edit mode
        if (isEditMode) {
            document.querySelectorAll('.editable-cell').forEach(cell => {
                cell.addEventListener('change', handleCellChange);
            });
        }
        sendToServerBtn.disabled = modifiedImages.size === 0;
    }

    /**
     * Handles changes in editable table cells (ALT text or File Name).
     * Updates the `modifiedImages` map.
     * @param {Event} event - The change event from an input/textarea.
     */
    function handleCellChange(event) {
        const input = event.target;
        const storyId = parseInt(input.dataset.storyId);
        const uid = input.dataset.uid;
        const field = input.dataset.field;
        const newValue = input.value;

        // Find the original image object in currentStoryImages
        const originalImage = currentStoryImages.find(img => img.storyId === storyId && img._uid === uid);

        if (!originalImage) {
            console.error('Original image not found for modification tracking:', { storyId, uid, field });
            return;
        }

        const uniqueKey = `${storyId}-${uid}`; // Key for the modifiedImages map

        if (!modifiedImages.has(uniqueKey)) {
            // If not tracked yet, add a new entry
            modifiedImages.set(uniqueKey, {
                storyId: storyId,
                _uid: uid,
                altText: originalImage.alt,
                fileName: originalImage.fileName,
                bynderImageRef: originalImage.bynderImageRef, // Reference to the bynder image object within the story JSON
                altTextRef: originalImage.altTextRef, // Reference to the alt text object within the story JSON
                originalParentField: originalImage.parentField,
                originalAlt: originalImage.alt,
                originalFileName: originalImage.fileName
            });
        }

        const modificationEntry = modifiedImages.get(uniqueKey);

        // Update the specific field
        if (field === 'altText') {
            modificationEntry.altText = newValue;
        } else if (field === 'fileName') {
            modificationEntry.fileName = newValue;
        }

        // Check if the modified value is different from the original
        const isAltChanged = modificationEntry.altText !== modificationEntry.originalAlt;
        const isFileNameChanged = modificationEntry.fileName !== modificationEntry.originalFileName;

        if (!isAltChanged && !isFileNameChanged) {
            // If both fields reverted to original, remove from modifiedImages
            modifiedImages.delete(uniqueKey);
        }

        sendToServerBtn.disabled = modifiedImages.size === 0;
    }

    // --- Core Logic ---

    /**
     * Loads the Storyblok MAPI token from localStorage and updates the input.
     */
    function loadSettings() {
        storyblokMapiToken = localStorage.getItem(STORYBLOK_TOKEN_KEY) || '';
        storyblokTokenInput.value = storyblokMapiToken;
        // Hide token by default
        storyblokTokenInput.type = 'password';
        toggleTokenVisibilityBtn.innerHTML = '<span class="icon-eye-closed"></span>';
        settingsPanel.classList.remove('active'); // Ensure panel is hidden on load
    }

    /**
     * Fetches all stories from Storyblok and populates the sidebar.
     */
    async function fetchAllStories() {
        toggleLoadingIndicator(loadingIndicatorSidebar, true);
        storyList.innerHTML = '';
        allStories = [];
        let page = 1;
        let hasMore = true;

        try {
            while (hasMore) {
                const url = `${BASE_MAPI_URL}/stories/?per_page=100&page=${page}&is_published=true&story_only=1&filter_query[component][not_in]=redirect&starts_with=damen/en&excluding_slugs=damen/en/general/*`;
                const response = await makeApiRequest(url);
                if (response.stories && response.stories.length > 0) {
                    /*allStories = allStories.concat(response.stories.map(s => ({
                        name: s.name,
                        id: s.id,
                        slug: s.slug,
                        full_slug: s.full_slug
                    })));
                    page++;
					*/
					allStories = allStories.concat(response.stories.map(s => {
						let processedFullSlug = s.full_slug;
                        if (s.full_slug === 'damen/en/home') {
                            processedFullSlug = s.full_slug.replace('damen/en/home', 'damen/en/');
                        }
                        return {
                            name: s.name,
                            id: s.id,
                            slug: s.slug,
                            full_slug: processedFullSlug // Используем обработанный full_slug
                        };
                    }));
                    page++;
                } else {
                    hasMore = false;
                }
            }
            allStories.sort((a, b) => a.full_slug.localeCompare(b.full_slug));
            renderStoryList();
            if (allStories.length === 0) {
                storyList.innerHTML = '<p class="placeholder-text">No stories found.</p>';
            }
			else
			{
				showModal('Success', `Successfully connected and loaded ${allStories.length} stories.`);
			}
        } catch (error) {
            showModal('Error', `Failed to fetch stories: ${error.message}`);
            storyList.innerHTML = '<p class="placeholder-text">Error loading stories. Check console for details.</p>';
        } finally {
            toggleLoadingIndicator(loadingIndicatorSidebar, false);
        }
    }

    /**
     * Renders the list of stories in the sidebar.
     */
    /* OLD renderStoryList() function renderStoryList() {
        storyList.innerHTML = ''; // Clear existing list
        const fragment = document.createDocumentFragment();

        allStories.forEach(story => {
            const storyItem = document.createElement('div');
            storyItem.className = 'story-item';
            storyItem.dataset.storyId = story.id; // Store story ID for selection

            const topRow = document.createElement('div');
            topRow.className = 'top-row';

            // Story Name Link
            const storyNameLink = document.createElement('a');
            storyNameLink.href = '#'; // Prevent default navigation
            storyNameLink.className = 'story-name-link';
            storyNameLink.textContent = story.name;
            storyNameLink.addEventListener('click', (e) => {
                e.preventDefault();
                loadStoryDetails(story.id);
            });
            topRow.appendChild(storyNameLink);

            // Settings Icon Link
            const settingsIconLink = document.createElement('a');
            settingsIconLink.href = `${STORYBLOK_APP_URL}/${story.id}`;
            settingsIconLink.target = '_blank';
            settingsIconLink.className = 'settings-icon-link';
            settingsIconLink.innerHTML = '⚙️'; // Gear icon
            topRow.appendChild(settingsIconLink);

            storyItem.appendChild(topRow);

            // Weblink
            const weblink = document.createElement('a');
            let fullWeblink = story.full_slug.replace('damen/en', DAMEN_WEBSITE_BASE_URL);
            if (fullWeblink.endsWith('/')) {
                fullWeblink = fullWeblink.slice(0, -1);
            }
            weblink.href = fullWeblink;
            weblink.target = '_blank';
            weblink.className = 'weblink';
            weblink.textContent = fullWeblink;
            storyItem.appendChild(weblink);

            fragment.appendChild(storyItem);
        });
        storyList.appendChild(fragment);
    }*/
	
    function renderStoryList() {
        storyList.innerHTML = ''; // Clear existing list
        const fragment = document.createDocumentFragment();

        allStories.forEach(story => {
            const storyItem = document.createElement('div');
            storyItem.className = 'story-item';
            storyItem.dataset.storyId = story.id; // Store story ID for selection

            // Calculate indentation based on full_slug
            const slugParts = story.full_slug.split('/');
            // Count non-empty parts after the initial 'damen/en'
            // For 'damen/en/product/example', parts are ['', 'damen', 'en', 'product', 'example']
            // We want 0 indent for 'damen/en', 1 for 'damen/en/product', etc.
            const indentationLevel = Math.max(0, slugParts.filter(part => part !== '').length - 2);
            storyItem.style.paddingLeft = `${indentationLevel * 15}px`; // 15px per level of indentation

            const topRow = document.createElement('div');
            topRow.className = 'top-row';

            // Story Name Link
            const storyNameLink = document.createElement('a');
            storyNameLink.href = '#'; // Prevent default navigation
            storyNameLink.className = 'story-name-link';
            storyNameLink.textContent = story.name;
            storyNameLink.addEventListener('click', (e) => {
                e.preventDefault();
                loadStoryDetails(story.id);
            });
            topRow.appendChild(storyNameLink);

            // Settings Icon Link
            const settingsIconLink = document.createElement('a');
            settingsIconLink.href = `${STORYBLOK_APP_URL}/${story.id}`;
            settingsIconLink.target = '_blank';
            settingsIconLink.className = 'settings-icon-link';
            settingsIconLink.innerHTML = '⚙️'; // Gear icon
            topRow.appendChild(settingsIconLink);

            storyItem.appendChild(topRow);

            // Weblink
            const weblink = document.createElement('a');
            let fullWeblink = story.full_slug.replace('damen/en', DAMEN_WEBSITE_BASE_URL);
            if (fullWeblink.endsWith('/')) {
                fullWeblink = fullWeblink.slice(0, -1);
            }
            weblink.href = fullWeblink;
            weblink.target = '_blank';
            weblink.className = 'weblink';
            weblink.textContent = fullWeblink;
            storyItem.appendChild(weblink);

            fragment.appendChild(storyItem);
        });
        storyList.appendChild(fragment);
    }

    /**
     * Loads the details of a specific story and populates the main table.
     * @param {number} storyId - The ID of the story to load.
     */
    async function loadStoryDetails(storyId) {
        toggleLoadingIndicator(loadingIndicatorMain, true);
        currentStoryTitle.textContent = 'Loading Story...';
        imageTableBody.innerHTML = '<tr><td colspan="5" class="table-placeholder">Loading images...</td></tr>';
        currentStoryImages = [];
        currentStoryData = null; // Clear previous story data
        modifiedImages.clear(); // Clear modifications for new story
        sendToServerBtn.disabled = true;
        //toggleEditBtn.disabled = false;
        //isEditMode = false; // Reset edit mode
        //toggleEditBtn.textContent = 'Toggle Edit Mode';

        try {
            // Fetch main story
            const mainStoryResponse = await makeApiRequest(`${BASE_MAPI_URL}/stories/${storyId}`);
            const mainStoryJson = mainStoryResponse;
            currentStoryData = mainStoryJson; // Store the original full story JSON

            currentStoryTitle.textContent = mainStoryJson.story.name;

            // Extract images from main story
            const mainStoryExtractedImages = extractImagesFromStoryJson(mainStoryJson, storyId);
            currentStoryImages = currentStoryImages.concat(mainStoryExtractedImages);

            // Check for linked stories and fetch them
            const content = mainStoryJson.story.content;
            let linkedStoryUuid = null;
            let linkedStoryFieldName = null; // To keep track of where the UUID came from

            const componentMap = {
                'product_detail_page': 'product',
                'used_product_detail_page': 'product',
                'charter_product_detail_page': 'product',
                'event_detail_page': 'event',
                'project_detail_page': 'project',
            };

            if (content.component && componentMap[content.component] && content[componentMap[content.component]]) {
                linkedStoryUuid = content[componentMap[content.component]];
                linkedStoryFieldName = componentMap[content.component];
            }

            if (linkedStoryUuid) {
                const linkedStoryResponse = await makeApiRequest(`${BASE_MAPI_URL}/stories/?by_uuids=${linkedStoryUuid}`);
                if (linkedStoryResponse.stories && linkedStoryResponse.stories.length > 0) {
                    const subStoryId = linkedStoryResponse.stories[0].id;
                    const subStoryDetailsResponse = await makeApiRequest(`${BASE_MAPI_URL}/stories/${subStoryId}`);
                    // Store sub-story JSON separately or merge if needed. For now, we only need its images.
                    // IMPORTANT: We need to keep a reference to the full sub-story JSON to send PUT requests for it.
                    // For simplicity, let's just assume we reload the substory JSON when sending changes.
                    // A more robust solution would be to store {storyId: fullJson} for all loaded stories.
                    // Given the constraint that sub-stories don't have further sub-stories, we'll refetch when needed.

                    const subStoryExtractedImages = extractImagesFromStoryJson(subStoryDetailsResponse, subStoryId);
                    currentStoryImages = currentStoryImages.concat(subStoryExtractedImages);
                }
            }
            renderImageTable(currentStoryImages);

        } catch (error) {
            showModal('Error', `Failed to load story details: ${error.message}`);
            currentStoryTitle.textContent = 'Select a Story to View Images';
            imageTableBody.innerHTML = '<tr><td colspan="5" class="table-placeholder">Error loading images.</td></tr>';
            //toggleEditBtn.disabled = true;
        } finally {
            toggleLoadingIndicator(loadingIndicatorMain, false);
        }
    }

    /**
     * Toggles the edit mode for the image table.
     */
    function toggleEditMode() {
        isEditMode = !isEditMode;
        toggleEditBtn.textContent = isEditMode ? 'Edit Mode ON' : 'Edit Mode OFF';
		toggleEditBtn.style.backgroundColor = isEditMode ? 'green' : '#6c757d';
        document.querySelectorAll('.editable-cell').forEach(cell => {
            cell.readOnly = !isEditMode;
            cell.classList.toggle('editable', isEditMode);
            // Re-attach or remove event listeners based on edit mode
            if (isEditMode) {
                cell.addEventListener('change', handleCellChange);
            } else {
                cell.removeEventListener('change', handleCellChange);
            }
        });
        // If exiting edit mode, clear modifications if no changes were sent
        if (!isEditMode && modifiedImages.size > 0) {
            // Optionally, ask user if they want to discard changes
            // For now, let's keep them if not sent
        }
    }

    /**
     * Sends modified image data to the Storyblok API via PUT requests.
     */
    async function sendModificationsToServer() {
        if (modifiedImages.size === 0) {
            showModal('Info', 'No changes to send.');
            return;
        }

        toggleLoadingIndicator(loadingIndicatorMain, true);
        sendToServerBtn.disabled = true; // Disable to prevent double-clicks
        let hasErrors = false;
        const storiesToUpdate = new Map(); // Map<storyId, fullStoryJson>

        try {
            // Group modifications by storyId
            for (const [key, mod] of modifiedImages.entries()) {
                if (!storiesToUpdate.has(mod.storyId)) {
                    // Fetch the full story JSON for the story being updated
                    // This ensures we send the latest state, not a potentially stale one
                    const storyResponse = await makeApiRequest(`${BASE_MAPI_URL}/stories/${mod.storyId}`);
                    storiesToUpdate.set(mod.storyId, storyResponse.story);
                }
            }

            for (const [key, mod] of modifiedImages.entries()) {
                const storyToUpdate = storiesToUpdate.get(mod.storyId);
                if (!storyToUpdate) {
                    throw new Error(`Story data not found for ID: ${mod.storyId}`);
                }

                // Recursively find and update the specific bynder_image component
                function updateImageRecursive(obj) {
                    if (typeof obj !== 'object' || obj === null) {
                        return;
                    }

                    if (Array.isArray(obj)) {
                        obj.forEach(item => updateImageRecursive(item));
                    } else {
                        for (const prop in obj) {
                            if (obj.hasOwnProperty(prop)) {
                                if (Array.isArray(obj[prop]) && obj[prop].length > 0 && obj[prop][0] && obj[prop][0].component === 'bynder_image') {
                                    obj[prop].forEach(imageWrapper => {
                                        if (imageWrapper._uid === mod._uid) { // Found the exact imageWrapper
                                            let fileNameChanged = false;
											mod.fileName = mod.fileName.replace(/\s+/g, '-').toLowerCase();//2025-09-28 new
                                            if (mod.fileName !== mod.originalFileName) {
                                                imageWrapper.image[0].name = mod.fileName;
                                                fileNameChanged = true;
                                            }
                                            if (mod.altText !== mod.originalAlt) {
                                                imageWrapper.alt = mod.altText;
                                            }

                                            // Update transformBaseUrl.url if fileName has changed
                                            if (fileNameChanged) {
                                                const bynderImage = imageWrapper.image[0];
                                                const oldTransformUrl = bynderImage.files.transformBaseUrl.url;
                                                const lastSlashIndex = oldTransformUrl.lastIndexOf('/');
                                                if (lastSlashIndex !== -1) {
                                                    const baseUrl = oldTransformUrl.substring(0, lastSlashIndex + 1);
                                                    bynderImage.files.transformBaseUrl.url = baseUrl + mod.fileName;
                                                }
                                            }
                                        }
                                    });
                                } else {
                                    updateImageRecursive(obj[prop]);
                                }
                            }
                        }
                    }
                }
                updateImageRecursive(storyToUpdate.content);
            }

            // Send PUT requests for each story that had modifications
            for (const [storyId, updatedStoryJson] of storiesToUpdate.entries()) {
                const putUrl = `${BASE_MAPI_URL}/stories/${storyId}`;
                await makeApiRequest(putUrl, 'PUT', {
                    story: updatedStoryJson,
                    publish: 1
                });
                console.log(`Successfully updated story ID: ${storyId}`);
            }

            showModal('Success', 'Changes sent to server successfully! Reloading data...', true);
            modifiedImages.clear(); // Clear modifications after successful send
            // Reload the current story to reflect changes and update `currentStoryImages`
            await loadStoryDetails(currentStoryData.story.id);

        } catch (error) {
            hasErrors = true;
            showModal('Error', `Failed to send changes to server: ${error.message}`);
        } finally {
            toggleLoadingIndicator(loadingIndicatorMain, false);
            sendToServerBtn.disabled = modifiedImages.size === 0;
        }
    }


    // --- Event Listeners ---

    // Settings Panel controls
    settingsBtn.addEventListener('click', () => {
		settingsPanel.classList.toggle('active');
		// For smooth transition, only hide/show display property when not active
		if (settingsPanel.classList.contains('active')) {
			settingsPanel.classList.remove('hidden');
		} else {
			setTimeout(() => settingsPanel.classList.add('hidden'), 300); // Match transition duration
		}
    });

    closeSettingsBtn.addEventListener('click', () => {
		settingsPanel.classList.toggle('active');
		// For smooth transition, only hide/show display property when not active
		if (settingsPanel.classList.contains('active')) {
			settingsPanel.classList.remove('hidden');
		} else {
			setTimeout(() => settingsPanel.classList.add('hidden'), 300); // Match transition duration
		}
    });

    saveSettingsBtn.addEventListener('click', () => {
        storyblokMapiToken = storyblokTokenInput.value.trim();
        localStorage.setItem(STORYBLOK_TOKEN_KEY, storyblokMapiToken);
        showModal('Settings Saved', 'Storyblok MAPI token has been saved.');
        settingsPanel.classList.remove('active');
    });

    toggleTokenVisibilityBtn.addEventListener('click', () => {
        if (storyblokTokenInput.type === 'password') {
            storyblokTokenInput.type = 'text';
            toggleTokenVisibilityBtn.innerHTML = '<span class="icon-eye-open"></span>';
        } else {
            storyblokTokenInput.type = 'password';
            toggleTokenVisibilityBtn.innerHTML = '<span class="icon-eye-closed"></span>';
        }
    });

    // Connect to Storyblok button
    connectBtn.addEventListener('click', fetchAllStories);

    // Toggle Edit Mode button
    toggleEditBtn.addEventListener('click', toggleEditMode);

    // Send to Server button
    sendToServerBtn.addEventListener('click', sendModificationsToServer);

    // Modal Close button
    modalCloseBtn.addEventListener('click', hideModal);

    // Initial setup
    loadSettings();
});

// --- END OF FILE script.js ---