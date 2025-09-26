document.addEventListener('DOMContentLoaded', () => {

    // --- Image Click-to-Zoom ---
    const figures = document.querySelectorAll('.post-figure');

    figures.forEach(figure => {
        figure.addEventListener('click', () => {
            const imgSrc = figure.querySelector('img').src;
            
            const modal = document.createElement('div');
            modal.className = 'image-modal';
            modal.innerHTML = `
                <span class="close-button">&times;</span>
                <img src="${imgSrc}" alt="Full-size view">
            `;
            document.body.appendChild(modal);
            
            // Trigger the fade-in animation
            setTimeout(() => modal.classList.add('visible'), 10);

            const closeModal = () => {
                modal.classList.remove('visible');
                setTimeout(() => modal.remove(), 300); // Wait for fade-out
            };

            modal.addEventListener('click', closeModal);
        });
    });

    // --- Animated Reaction Buttons ---
    const reactButtons = document.querySelectorAll('.react-buttons .icon-btn');
    reactButtons.forEach(button => {
        button.addEventListener('click', () => {
            button.classList.toggle('active'); // Toggles a visual "clicked" state
        });
    });
});