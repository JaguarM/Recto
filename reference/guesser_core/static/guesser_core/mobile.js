/* 
   Modular Mobile Support for Epstein Unredactor
   Handles backdrop management and sidebar overlays on small screens.
*/

(function() {
    const backdrop = document.getElementById('sidebar-backdrop');
    const leftSidebar = document.getElementById('sidebar');
    const rightSidebar = document.getElementById('tools-sidebar');
    const leftToggle = document.getElementById('toggle-sidebar');
    const rightToggle = document.getElementById('toggle-tools');

    function isMobile() {
        return window.innerWidth <= 768;
    }

    function updateBackdrop() {
        if (!isMobile()) {
            backdrop.classList.add('hidden');
            return;
        }

        const leftOpen = !leftSidebar.classList.contains('hidden');
        const rightOpen = !rightSidebar.classList.contains('hidden');

        if (leftOpen || rightOpen) {
            backdrop.classList.remove('hidden');
        } else {
            backdrop.classList.add('hidden');
        }
    }

    function closeAllSidebars() {
        if (!leftSidebar.classList.contains('hidden')) {
            leftSidebar.classList.add('hidden');
            if (leftToggle) leftToggle.classList.remove('active');
        }
        if (!rightSidebar.classList.contains('hidden')) {
            rightSidebar.classList.add('hidden');
            if (rightToggle) rightToggle.classList.remove('active');
        }
        updateBackdrop();
    }

    // Backdrop click-to-close behavior
    if (backdrop) {
        backdrop.addEventListener('click', closeAllSidebars);
    }

    // Hook into sidebar toggles
    // We use a MutationObserver to detect sidebar visibility changes
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.attributeName === 'class') {
                updateBackdrop();
            }
        });
    });

    if (leftSidebar) observer.observe(leftSidebar, { attributes: true });
    if (rightSidebar) observer.observe(rightSidebar, { attributes: true });

    // Handle orientation/resize changes
    window.addEventListener('resize', () => {
        if (!isMobile()) {
            backdrop.classList.add('hidden');
        } else {
            updateBackdrop();
        }
    });

})();
