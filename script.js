document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const settingsPanel = document.getElementById('settings-panel');
    const settingsButton = document.getElementById('settings-button');
    const closeSettingsButton = document.getElementById('close-settings');
    const storyblokTokenInput = document.getElementById('storyblok-token');
    const toggleTokenVisibilityButton = document.getElementById('toggle-token-visibility');
    const saveTokenButton = document.getElementById('save-token');
    const connectButton = document.getElementById('connect-button');
    const loadingIndicator = document.getElementById('loading-indicator');
    const tableLoadingIndicator = document.getElementById('table-loading-indicator');
    const storyTree = document.getElementById('story-tree');
    const mainStoryTableBody = document.getElementById('main-story-table').querySelector('tbody');
    const toggleAllDetailsButton = document.getElementById('toggle-all-details');
    const toggleEditModeButton = document.getElementById('toggle-edit-mode');
    const sendToServerButton = document.getElementById('send-to-server');

    // Constants
    const STORYBLOK_SPACE_ID = '103684';
    const BASE_API_URL = `https://mapi.storyblok.com/v1/spaces/${STORYBLOK_SPACE_ID}/`;
    const BASE_DAMEN_URL = 'https://www.damen.com';
    const BASE_STORYBLOK_APP_URL = `https://app.storyblok.com/#/me/spaces/${STORYBLOK_SPACE_ID}/stories/0/0/`;
    const BASE_BYNDER_URL = 'https://medialibrary.damen.com/media/?mediaId=';
    const TOKEN_STORAGE_KEY = 'storyblokMapiToken';

    // State Variables
    let storyblokMapiToken = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    let allStoriesFullSlugs = [];
    let currentTableStories = []; // Stores stories currently displayed in the main table
    let isEditMode = false;
    let changedStories = new Set(); // Stores storyIds of stories that have been modified (main or related)
    
    // New state to track which main story "owns" which related stories, and all images data
    // This will help in knowing which story to update when an image field is changed.
    let imageModifications = new Map(); // Map<storyId (main or related), Map<imageBynderId, {originalFileName, originalAlt, newFileName, newAlt}>>
    let storyToRelatedMap = new Map(); // Map<mainStoryId, Set<relatedStoryId>> // To track parent-child relationships for PUT requests
    let allLoadedStoriesContent = new Map(); // Map<storyId, story.content> of all stories (main and related) that have their images loaded

    // --- Helper Functions ---

    /**
     * Shows a loading indicator.
     * @param {HTMLElement} element
     */
    function showLoading(element, text = 'Loading...') {
        element.textContent = text;
        element.classList.remove('hidden');
    }

    /**
     * Hides a loading indicator.
     * @param {HTMLElement} element
     */
    function hideLoading(element) {
        element.classList.add('hidden');
    }

    /**
     * Fetches data from Storyblok API.
     * @param {string} endpoint - The API endpoint relative to BASE_API_URL.
     * @param {Object} params - Query parameters.
     * @returns {Promise<Object|null>} JSON response or null on error.
     */
    async function fetchStoryblokApi(endpoint, params = {}) {
        if (!storyblokMapiToken) {
            // No alert here, as it's handled by connectButton click
            console.error('MAPI Token is missing.');
            return null;
        }

        const queryString = new URLSearchParams(params).toString();
        const url = `${BASE_API_URL}${endpoint}${queryString ? `?${queryString}` : ''}`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': storyblokMapiToken,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Error fetching from Storyblok API:', error);
            alert(`Error connecting to Storyblok: ${error.message}`);
            return null;
        }
    }

    /**
     * Sends a PUT request to Storyblok API.
     * @param {string} endpoint - The API endpoint relative to BASE_API_URL.
     * @param {Object} data - The payload to send.
     * @returns {Promise<Object|null>} JSON response or null on error.
     */
    async function putStoryblokApi(endpoint, data) {
        if (!storyblokMapiToken) {
            console.error('MAPI Token is missing.');
            return null;
        }

        const url = `${BASE_API_URL}${endpoint}`;

        try {
            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': storyblokMapiToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    story: data,
                    publish: 1 // Publish changes immediately
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`PUT request failed: ${response.status} ${response.statusText} - ${errorText}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Error sending PUT request to Storyblok API:', error);
            alert(`Error updating Storyblok: ${error.message}`);
            return null;
        }
    }

    /**
     * Recursively extracts image objects from a story JSON.
     * @param {Object} obj - The current object to search.
     * @returns {Array} An array of found image objects.
     */
    function extractImages(obj) {
        let images = [];
        if (typeof obj !== 'object' || obj === null) {
            return images;
        }

        // Check if the current object itself is an image structure
        // Also ensure it has a databaseId, which is crucial for tracking
        if (obj.component === 'bynder_image' && obj.image && obj.image.length > 0 && obj.image[0].databaseId) {
            images.push(obj);
        }

        // Recursively search in arrays
        if (Array.isArray(obj)) {
            for (const item of obj) {
                images = images.concat(extractImages(item));
            }
        } else { // Recursively search in objects
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    images = images.concat(extractImages(obj[key]));
                }
            }
        }
        return images;
    }

    /**
     * Finds and returns a specific image object within the story JSON by its Bynder ID.
     * This is crucial for updating the correct image data for PUT requests.
     * @param {Object} storyContent - The `story.content` object of a story.
     * @param {string} imageBynderId - The Bynder ID of the image to find.
     * @returns {Object|null} The found image object or null.
     */
    function findImageInStoryContentById(storyContent, imageBynderId) {
        const findRecursive = (obj) => {
            if (typeof obj !== 'object' || obj === null) return null;

            if (obj.component === 'bynder_image' && obj.image && obj.image.length > 0) {
                const bynderImage = obj.image[0];
                if (bynderImage.databaseId === imageBynderId) {
                    return obj; // Return the 'bynder_image' component object
                }
            }

            if (Array.isArray(obj)) {
                for (const item of obj) {
                    const found = findRecursive(item);
                    if (found) return found;
                }
            } else {
                for (const key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) {
                        const found = findRecursive(obj[key]);
                        if (found) return found;
                    }
                }
            }
            return null;
        };

        return findRecursive(storyContent);
    }


    // --- Settings Panel Logic ---

    settingsButton.addEventListener('click', () => {
        settingsPanel.classList.remove('hidden');
        settingsPanel.classList.add('visible');
        storyblokTokenInput.value = storyblokMapiToken;
        // Set input type to password by default
        storyblokTokenInput.type = 'password';
        toggleTokenVisibilityButton.textContent = '👁️';
    });

    closeSettingsButton.addEventListener('click', () => {
        settingsPanel.classList.remove('visible');
        settingsPanel.classList.add('hidden');
    });

    toggleTokenVisibilityButton.addEventListener('click', () => {
        if (storyblokTokenInput.type === 'password') {
            storyblokTokenInput.type = 'text';
            toggleTokenVisibilityButton.textContent = '🙈';
        } else {
            storyblokTokenInput.type = 'password';
            toggleTokenVisibilityButton.textContent = '👁️';
        }
    });

    saveTokenButton.addEventListener('click', () => {
        storyblokMapiToken = storyblokTokenInput.value.trim();
        localStorage.setItem(TOKEN_STORAGE_KEY, storyblokMapiToken);
        alert('Storyblok MAPI Token saved!');
        settingsPanel.classList.remove('visible');
        settingsPanel.classList.add('hidden');
    });

    // --- Connect to Storyblok Logic ---

    connectButton.addEventListener('click', async () => {
        if (!storyblokMapiToken) {
            alert('Please save your Storyblok MAPI Token in settings first.');
            return;
        }

        showLoading(loadingIndicator, 'Connecting...');
        allStoriesFullSlugs = [];
        let page = 1;
        let hasMore = true;

        storyTree.innerHTML = '<p class="placeholder-text">Loading stories...</p>'; // Clear and show loading for tree
        connectButton.disabled = true; // Disable connect button during loading

        try {
            while (hasMore) {
                const params = {
                    per_page: 100,
                    page: page,
                    is_published: true,
                    story_only: 1,
                    'filter_query[component][not_in]': 'redirect',
                    starts_with: 'damen/en'
                };
                const response = await fetchStoryblokApi('stories', params);

                if (response && response.stories.length > 0) {
                    allStoriesFullSlugs = allStoriesFullSlugs.concat(response.stories.map(s => s.full_slug));
                    page++;
                } else {
                    hasMore = false;
                }
            }

            allStoriesFullSlugs.sort(); // Sort full_slugs alphabetically
            buildStoryTree(allStoriesFullSlugs);
            alert('Successfully connected to Storyblok and loaded stories!');
            connectButton.classList.add('hidden'); // Hide after successful connection
        } finally {
            hideLoading(loadingIndicator);
            connectButton.disabled = false; // Re-enable in case of error (though button is hidden if success)
        }
    });

    // --- Story Tree Navigation Logic ---

    function buildStoryTree(slugs) {
        storyTree.innerHTML = ''; // Clear previous tree
        const root = {};

        slugs.forEach(slug => {
            const parts = slug.split('/').filter(p => p !== '');
            let currentLevel = root;
            parts.forEach((part, index) => {
                if (!currentLevel[part]) {
                    currentLevel[part] = {
                        _fullSlug: parts.slice(0, index + 1).join('/'),
                        _children: {},
                        _isLeaf: true
                    };
                    if (index < parts.length - 1) {
                        currentLevel[part]._isLeaf = false;
                    }
                }
                currentLevel = currentLevel[part]._children;
            });
        });
        
        const renderTree = (node, parentUl) => {
            const sortedKeys = Object.keys(node).sort((a, b) => {
                // Sort folders (non-leaves) before files (leaves)
                const isAFolder = !node[a]._isLeaf && Object.keys(node[a]._children).length > 0;
                const isBFolder = !node[b]._isLeaf && Object.keys(node[b]._children).length > 0;

                if (isAFolder && !isBFolder) return -1;
                if (!isAFolder && isBFolder) return 1;
                return a.localeCompare(b);
            });

            sortedKeys.forEach(key => {
                const item = node[key];
                const li = document.createElement('li');
                const div = document.createElement('div');
                div.classList.add('tree-node');
                div.dataset.fullSlug = item._fullSlug; // Store full slug

                const hasChildren = Object.keys(item._children).length > 0;
                const toggleIcon = document.createElement('span');
                toggleIcon.classList.add('tree-toggle-icon');
                toggleIcon.textContent = hasChildren ? '+' : ''; // Show + only if has children
                div.appendChild(toggleIcon);

                const itemName = document.createElement('span');
                itemName.classList.add('tree-item-name');
                itemName.textContent = key.endsWith('/') ? key : key.split('/').pop(); // Display only the last part or key with /
                if (item._fullSlug === 'damen/en') { // Handle the root 'damen/en' special case
                    itemName.textContent = 'Damen (EN)';
                }
                div.appendChild(itemName);
                li.appendChild(div);

                if (hasChildren) {
                    const ul = document.createElement('ul');
                    ul.classList.add('collapsed'); // Initially collapsed
                    li.appendChild(ul);
                    renderTree(item._children, ul);
                }
                parentUl.appendChild(li);
            });
        };

        const ul = document.createElement('ul');
        ul.classList.add('story-tree-root');
        renderTree(root, ul);
        storyTree.appendChild(ul);

        // Add event listeners for tree nodes
        storyTree.addEventListener('click', (event) => {
            const targetNode = event.target.closest('.tree-node');
            if (targetNode) {
                // Remove 'selected' class from previously selected node
                const currentSelected = storyTree.querySelector('.tree-node.selected');
                if (currentSelected) {
                    currentSelected.classList.remove('selected');
                }
                targetNode.classList.add('selected');

                const fullSlug = targetNode.dataset.fullSlug;
                if (fullSlug) {
                    loadMainTable(fullSlug);
                }

                // Toggle children visibility (only for nodes with children)
                const toggleIcon = targetNode.querySelector('.tree-toggle-icon');
                const childrenUl = targetNode.nextElementSibling;
                if (toggleIcon && childrenUl && childrenUl.tagName === 'UL') {
                    if (childrenUl.classList.contains('collapsed')) {
                        childrenUl.classList.remove('collapsed');
                        toggleIcon.textContent = '-';
                    } else {
                        childrenUl.classList.add('collapsed');
                        toggleIcon.textContent = '+';
                    }
                }
            }
        });
    }

    // --- Main Table Logic ---

    async function loadMainTable(fullSlug) {
        showLoading(tableLoadingIndicator, 'Loading table...');
        mainStoryTableBody.innerHTML = ''; // Clear existing table rows
        currentTableStories = []; // Reset current table stories
        changedStories.clear(); // Reset changed stories
        imageModifications.clear(); // Clear image modifications
        storyToRelatedMap.clear(); // Clear related stories map
        allLoadedStoriesContent.clear(); // Clear cached story content
        toggleEditModeButton.classList.add('hidden');
        sendToServerButton.classList.add('hidden');
        toggleAllDetailsButton.classList.add('hidden');
        isEditMode = false; // Reset edit mode state
        toggleEditModeButton.textContent = 'Enable Editing'; // Reset button text

        let page = 1;
        let hasMore = true;
        let storiesForTable = [];

        try {
            while (hasMore) {
                const params = {
                    per_page: 100,
                    page: page,
                    is_published: true,
                    story_only: 1,
                    'filter_query[component][not_in]': 'redirect',
                    starts_with: fullSlug // Use the full slug for filtering
                };
                const response = await fetchStoryblokApi('stories', params);

                if (response && response.stories.length > 0) {
                    storiesForTable = storiesForTable.concat(response.stories);
                    page++;
                } else {
                    hasMore = false;
                }
            }

            // Sort by the 'hidden' weblink column (which is derived from full_slug)
            storiesForTable.sort((a, b) => a.full_slug.localeCompare(b.full_slug));
            currentTableStories = storiesForTable; // Store for later use

            if (storiesForTable.length === 0) {
                mainStoryTableBody.innerHTML = '<tr><td colspan="4" class="placeholder-text">No stories found for this path.</td></tr>';
                return;
            }

            storiesForTable.forEach(story => {
                // Ensure BASE_DAMEN_URL doesn't end with / if story.full_slug starts with one after replacement
                const weblinkSlug = story.full_slug.replace('damen/en', '');
                const weblink = `${BASE_DAMEN_URL}${weblinkSlug.startsWith('/') ? weblinkSlug : '/' + weblinkSlug}`.replace(/\/$/, '');
                const storyblokLink = `${BASE_STORYBLOK_APP_URL}${story.id}`;

                const row = mainStoryTableBody.insertRow(); // Insert at the end by default
                row.dataset.storyId = story.id;
                row.dataset.fullSlug = story.full_slug;

                row.innerHTML = `
                    <td class="hidden">${weblink}</td>
                    <td><a href="${weblink}" target="_blank">${story.name}</a></td>
                    <td><a href="${storyblokLink}" target="_blank">link</a></td>
                    <td class="action-cell">
                        <button class="button secondary-button get-images-button" data-story-id="${story.id}">Get Images</button>
                    </td>
                `;
            });

            toggleEditModeButton.classList.remove('hidden');
            toggleAllDetailsButton.classList.remove('hidden');

        } finally {
            hideLoading(tableLoadingIndicator);
        }
    }

    // --- Image Details Logic ---

    mainStoryTableBody.addEventListener('click', async (event) => {
        const getImagesButton = event.target.closest('.get-images-button');
        if (getImagesButton) {
            const storyId = getImagesButton.dataset.storyId;
            await loadImagesForStory(storyId, getImagesButton);
        }
    });

    async function loadImagesForStory(mainStoryId, buttonElement) {
        const parentRow = buttonElement.closest('tr');
        // Check for existing detail row. If present, just toggle its visibility.
        const existingDetailRow = document.querySelector(`tr.detail-row[data-parent-story-id="${mainStoryId}"]`);

        if (existingDetailRow) {
            existingDetailRow.classList.toggle('hidden');
            return;
        }

        buttonElement.disabled = true;
        buttonElement.textContent = 'Loading...';

        try {
            const storyDetailsResponse = await fetchStoryblokApi(`stories/${mainStoryId}`);
            if (!storyDetailsResponse || !storyDetailsResponse.story) {
                alert('Could not fetch story details.');
                return;
            }

            const mainStory = storyDetailsResponse.story;
            allLoadedStoriesContent.set(mainStory.id, mainStory.content); // Cache main story content

            let allImages = extractImages(mainStory.content);
            let relatedStoryIds = new Set(); // Store actual Storyblok IDs of related stories

            // Check for related stories if component matches
            const component = mainStory.content.component;
            let relatedStoryUuids = []; // Store UUIDs, not IDs

            if (['product_detail_page', 'used_product_detail_page', 'charter_product_detail_page'].includes(component) && mainStory.content.product) {
                relatedStoryUuids.push(mainStory.content.product);
            } else if (component === 'event_detail_page' && mainStory.content.event) {
                relatedStoryUuids.push(mainStory.content.event);
            } else if (component === 'project_detail_page' && mainStory.content.project) {
                relatedStoryUuids.push(mainStory.content.project);
            }
            // Add other component checks here if needed, e.g., 'news_article' with 'author'
            // if (component === 'news_article' && story.content.author) {
            //     relatedStoryUuids.push(story.content.author);
            // }

            if (relatedStoryUuids.length > 0) {
                const uuidsString = relatedStoryUuids.join(',');
                const relatedStoriesResponse = await fetchStoryblokApi(`stories/?by_uuids=${uuidsString}`);
                if (relatedStoriesResponse && relatedStoriesResponse.stories && relatedStoriesResponse.stories.length > 0) {
                    for (const relatedStory of relatedStoriesResponse.stories) {
                        const relatedStoryDetailsResponse = await fetchStoryblokApi(`stories/${relatedStory.id}`);
                        if (relatedStoryDetailsResponse && relatedStoryDetailsResponse.story) {
                            allLoadedStoriesContent.set(relatedStory.id, relatedStoryDetailsResponse.story.content); // Cache related story content
                            allImages = allImages.concat(extractImages(relatedStoryDetailsResponse.story.content));
                            relatedStoryIds.add(relatedStory.id);
                        }
                    }
                }
            }

            // Store the map of main story to its related stories
            if (relatedStoryIds.size > 0) {
                storyToRelatedMap.set(mainStoryId, relatedStoryIds);
            }
            
            // Create the detail row
            const detailRow = mainStoryTableBody.insertRow(parentRow.sectionRowIndex + 1);
            detailRow.classList.add('detail-row');
            detailRow.dataset.parentStoryId = mainStoryId; // Link detail row to its parent story
            const detailCell = detailRow.insertCell(0);
            detailCell.colSpan = 4;

            if (allImages.length === 0) {
                detailCell.innerHTML = '<p class="placeholder-text" style="text-align: left; padding-left: 15px;">No images found for this story.</p>';
                return;
            }

            const imagesTable = document.createElement('table');
            imagesTable.classList.add('image-details-table');
            imagesTable.innerHTML = `
                <thead>
                    <tr>
                        <th style="width: 100px;">Image</th>
                        <th>Bynder Link</th>
                        <th>File Name</th>
                        <th>ALT Text</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            const imagesTableBody = imagesTable.querySelector('tbody');

            allImages.forEach(imgObj => {
                const bynderImg = imgObj.image[0]; // Assuming bynder_image component structure
                const thumbnailUrl = bynderImg.files.thumbnail.url;
                const transformUrl = bynderImg.files.transformBaseUrl.url;
                const bynderLink = BASE_BYNDER_URL + bynderImg.databaseId;
                const fileName = bynderImg.name;
                const altText = imgObj.alt;

                // Determine which story this specific image belongs to (main or related)
                // This requires iterating through allLoadedStoriesContent to find where this image resides.
                let actualStoryIdForImage = mainStoryId; // Default to main story
                for (const [sId, sContent] of allLoadedStoriesContent.entries()) {
                    if (findImageInStoryContentById(sContent, bynderImg.databaseId)) {
                        actualStoryIdForImage = sId;
                        break;
                    }
                }

                const imgRow = imagesTableBody.insertRow(); // This is the image-specific row in the detail table
                imgRow.dataset.originalAlt = altText; // Store original for change tracking
                imgRow.dataset.originalFileName = fileName;
                imgRow.dataset.originalTransformUrl = transformUrl; // Store original transform URL
                imgRow.dataset.parentStoryId = mainStoryId; // Parent story of the UI row
                imgRow.dataset.actualStoryId = actualStoryIdForImage; // The actual story ID this image belongs to in Storyblok
                imgRow.dataset.imageBynderId = bynderImg.databaseId; // Unique ID for image if needed

                imgRow.innerHTML = `
                    <td>
                        <div class="image-thumbnail-wrapper">
                            <a href="${transformUrl}" target="_blank">
                                <img src="${thumbnailUrl}" alt="${altText}" class="image-thumbnail">
                            </a>
                        </div>
                    </td>
                    <td><a href="${bynderLink}" target="_blank">link</a></td>
                    <td>
                        <input type="text" class="editable-field file-name-input" value="${fileName}" readonly data-original-value="${fileName}">
                    </td>
                    <td>
                        <input type="text" class="editable-field alt-text-input" value="${altText}" readonly data-original-value="${altText}">
                    </td>
                `;

                // Add event listeners for input changes
                const fileNameInput = imgRow.querySelector('.file-name-input');
                const altTextInput = imgRow.querySelector('.alt-text-input');

                const handleInputChange = (event) => {
                    const currentInput = event.target;
                    const imageDetailRow = currentInput.closest('tr'); // Get the specific image row
                    const actualStoryId = imageDetailRow.dataset.actualStoryId; // The story this image is truly part of
                    const imageBynderId = imageDetailRow.dataset.imageBynderId;

                    const originalFileName = imageDetailRow.dataset.originalFileName;
                    const originalAlt = imageDetailRow.dataset.originalAlt;
                    const originalTransformUrl = imageDetailRow.dataset.originalTransformUrl; // Get original transform URL

                    const newFileName = fileNameInput.value;
                    const newAlt = altTextInput.value;

                    // Initialize modification map for this story if not present
                    if (!imageModifications.has(actualStoryId)) {
                        imageModifications.set(actualStoryId, new Map());
                    }
                    const storyMods = imageModifications.get(actualStoryId);

                    // Track if this specific image field has changed
                    const isFileNameChanged = newFileName !== originalFileName;
                    const isAltTextChanged = newAlt !== originalAlt;

                    if (isFileNameChanged || isAltTextChanged) {
                        storyMods.set(imageBynderId, {
                            originalFileName, originalAlt, originalTransformUrl, newFileName, newAlt
                        });
                        imageDetailRow.classList.add('modified-image-row'); // Mark image detail row as modified
                        changedStories.add(actualStoryId); // Mark the actual story as changed
                        sendToServerButton.classList.remove('hidden'); // Show send button
                    } else {
                        // If current input went back to original, remove from specific image modifications
                        storyMods.delete(imageBynderId);
                        imageDetailRow.classList.remove('modified-image-row');

                        // Check if the actual story still has any modifications
                        if (storyMods.size === 0) {
                            imageModifications.delete(actualStoryId); // Remove story from map if no images modified
                            changedStories.delete(actualStoryId); // Remove actual story from changed set
                        }

                        if (changedStories.size === 0) {
                            sendToServerButton.classList.add('hidden'); // Hide if no changes left
                        }
                    }
                };

                fileNameInput.addEventListener('change', handleInputChange);
                altTextInput.addEventListener('change', handleInputChange);
            });

            detailCell.appendChild(imagesTable);
            // After inserting, apply edit mode if already active
            setEditMode(isEditMode);

        } finally {
            buttonElement.disabled = false;
            buttonElement.textContent = 'Get Images';
        }
    }

    // --- Global Image Details Controls ---

    toggleAllDetailsButton.addEventListener('click', async () => {
        const allGetImageButtons = document.querySelectorAll('.get-images-button:not([disabled])');
        const allDetailRows = document.querySelectorAll('.detail-row');

        const areAllCollapsed = Array.from(allDetailRows).every(row => row.classList.contains('hidden'));

        if (areAllCollapsed) {
            // Expand all
            toggleAllDetailsButton.textContent = 'Collapse All Images';
            for (const button of allGetImageButtons) {
                const storyId = button.dataset.storyId;
                const existingDetailRow = document.querySelector(`tr.detail-row[data-parent-story-id="${storyId}"]`);
                if (existingDetailRow) {
                    existingDetailRow.classList.remove('hidden');
                } else {
                    await loadImagesForStory(storyId, button); // Await each load to prevent too many parallel requests
                }
            }
        } else {
            // Collapse all
            allDetailRows.forEach(row => row.classList.add('hidden'));
            toggleAllDetailsButton.textContent = 'Expand All Images';
        }
    });

    toggleEditModeButton.addEventListener('click', () => {
        isEditMode = !isEditMode;
        setEditMode(isEditMode);
        toggleEditModeButton.textContent = isEditMode ? 'Disable Editing' : 'Enable Editing';
    });

    function setEditMode(enable) {
        document.querySelectorAll('.editable-field').forEach(input => {
            if (enable) {
                input.removeAttribute('readonly');
            } else {
                input.setAttribute('readonly', 'readonly');
            }
        });
        // Show/hide send button based on actual changes, and only if edit mode is enabled
        if (changedStories.size > 0 && enable) {
            sendToServerButton.classList.remove('hidden');
        } else {
            sendToServerButton.classList.add('hidden');
        }
    }

    // --- Send Changes to Server Logic ---

    sendToServerButton.addEventListener('click', async () => {
        if (changedStories.size === 0) {
            alert('No changes to send to the server.');
            return;
        }

        if (!confirm(`Are you sure you want to send changes for ${changedStories.size} stories to Storyblok? This will publish them.`)) {
            return;
        }

        showLoading(loadingIndicator, 'Sending changes...');
        let successCount = 0;
        let failCount = 0;
        let storiesToProcess = Array.from(changedStories); // Create a copy to iterate over

        for (const storyIdToUpdate of storiesToProcess) {
            const modsForThisStory = imageModifications.get(storyIdToUpdate);
            if (!modsForThisStory || modsForThisStory.size === 0) {
                // Should not happen if `changedStories` is kept in sync, but as a safeguard.
                console.warn(`No modifications found for storyId: ${storyIdToUpdate}, even though it's in changedStories. Skipping.`);
                changedStories.delete(storyIdToUpdate);
                continue;
            }

            // 1. Fetch the latest story data before applying changes
            const latestStoryResponse = await fetchStoryblokApi(`stories/${storyIdToUpdate}`);
            if (!latestStoryResponse || !latestStoryResponse.story) {
                console.warn(`Could not fetch latest story data for storyId: ${storyIdToUpdate}. Skipping PUT for this story.`);
                failCount++;
                changedStories.delete(storyIdToUpdate); // Remove from set if we can't get fresh data
                continue;
            }
            let storyToUpdate = latestStoryResponse.story;
            let modifiedStoryContent = storyToUpdate.content; // Directly modify the content of the fresh story

            let actualChangesApplied = false;
            for (const [imageBynderId, mod] of modsForThisStory.entries()) {
                const imageObj = findImageInStoryContentById(modifiedStoryContent, imageBynderId);

                if (imageObj) {
                    // Apply changes to the image object in our modified content
                    const bynderImage = imageObj.image[0];

                    let fileNameChanged = false;
                    if (bynderImage.name !== mod.newFileName) {
                        bynderImage.name = mod.newFileName;
                        fileNameChanged = true;
                    }
                    if (imageObj.alt !== mod.newAlt) {
                        imageObj.alt = mod.newAlt;
                    }

                    // Update transformBaseUrl.url if fileName has changed
                    if (fileNameChanged) {
                        const oldTransformUrl = bynderImage.files.transformBaseUrl.url;
                        const lastSlashIndex = oldTransformUrl.lastIndexOf('/');
                        if (lastSlashIndex !== -1) {
                            const baseUrl = oldTransformUrl.substring(0, lastSlashIndex + 1);
                            bynderImage.files.transformBaseUrl.url = baseUrl + mod.newFileName;
                        } else {
                            // If no slash, just replace the whole URL (unlikely for Bynder transform URLs)
                            bynderImage.files.transformBaseUrl.url = mod.newFileName;
                        }
                    }
                    actualChangesApplied = true;
                } else {
                    console.warn(`Could not find image with Bynder ID: "${imageBynderId}" in story ${storyIdToUpdate} for update. Skipping this image.`);
                }
            }

            if (!actualChangesApplied) {
                console.log(`No actual changes were applied for story ${storyIdToUpdate} after re-evaluation. Skipping PUT.`);
                changedStories.delete(storyIdToUpdate); // Remove from changed set if no actual changes were applied
                imageModifications.delete(storyIdToUpdate); // Clear modifications for this story
                continue; // Skip PUT if no changes were actually applied
            }

            // The 'storyToUpdate' object already has its 'content' modified
            const result = await putStoryblokApi(`stories/${storyIdToUpdate}`, storyToUpdate);

            if (result) {
                successCount++;
                // After successful save, update the original values in the UI and remove modified classes
                // Find all image rows belonging to this actual storyId (main or related)
                document.querySelectorAll(`tr[data-actual-story-id="${storyIdToUpdate}"]`).forEach(row => {
                    const imageBynderId = row.dataset.imageBynderId;
                    const mods = modsForThisStory.get(imageBynderId);

                    if (mods) { // If this image was modified and successfully sent
                        const altInput = row.querySelector('.alt-text-input');
                        const fileNameInput = row.querySelector('.file-name-input');
                        
                        row.dataset.originalAlt = altInput.value;
                        altInput.dataset.originalValue = altInput.value; // Update data-original-value
                        
                        row.dataset.originalFileName = fileNameInput.value;
                        fileNameInput.dataset.originalValue = fileNameInput.value; // Update data-original-value

                        // Update the stored original transform URL in the UI row dataset
                        const oldTransformUrl = row.dataset.originalTransformUrl;
                        const lastSlashIndex = oldTransformUrl.lastIndexOf('/');
                        if (lastSlashIndex !== -1) {
                            row.dataset.originalTransformUrl = oldTransformUrl.substring(0, lastSlashIndex + 1) + fileNameInput.value;
                        } else {
                            row.dataset.originalTransformUrl = fileNameInput.value;
                        }

                        row.classList.remove('modified-image-row'); // Remove modification visual
                    }
                });
                
                changedStories.delete(storyIdToUpdate); // Remove from changed set
                imageModifications.delete(storyIdToUpdate); // Clear modifications for this story
            } else {
                failCount++;
                // If update failed, the story remains in `changedStories` and `imageModifications`
                // for the user to potentially retry. No UI updates for this story.
            }
        }

        hideLoading(loadingIndicator);
        alert(`Changes sent: ${successCount} successful, ${failCount} failed.`);
        // Hide send button if no more stories are marked as changed
        if (changedStories.size === 0) {
            sendToServerButton.classList.add('hidden');
        }
    });

    // --- Initial setup ---
    // Check for token on load and potentially hide connect button if already connected
    if (storyblokMapiToken) {
        console.log('Storyblok MAPI Token found. Ready to connect.');
        // Optionally, could immediately trigger connect here or just keep the button visible
        // For now, let's keep it visible so the user can manually connect or refresh data.
        // If you want it to auto-connect on load, uncomment the line below:
        // connectButton.click(); 
    } else {
        console.log('No Storyblok MAPI Token found. Please enter it in settings.');
    }
});