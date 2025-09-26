document.addEventListener('DOMContentLoaded', function() {
    const imageContainers = document.querySelectorAll('.image-container');
    
    imageContainers.forEach(container => {
        container.addEventListener('click', function(event) {
            // Ensure the click is on the image itself
            if (event.target.classList.contains('project-image')) {
                const imageSrc = event.target.src;
                const linkUrl = container.getAttribute('data-link');
                
                // Create the modal pop-up
                const modal = document.createElement('div');
                modal.className = 'image-modal';
                modal.innerHTML = `
                    <span class="close-button">&times;</span>
                    <img src="${imageSrc}" alt="Full size project image">
                    <div class="modal-text">Go to <i>Link</i></div>
                `;
                document.body.appendChild(modal);
                document.body.style.overflow = 'hidden';

                // Function to close the modal
                const closeModal = () => {
                    modal.remove();
                    document.body.style.overflow = '';
                };

                // Event listeners to close the modal
                modal.querySelector('.close-button').addEventListener('click', closeModal);
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) {
                        closeModal();
                    }
                });

                // Event listener for the "Go to Link" text
                modal.querySelector('.modal-text').addEventListener('click', () => {
                    window.open(linkUrl, '_blank');
                    closeModal();
                });
            }
        });
    });
});