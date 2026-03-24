const posts = [];

const getAllPosts = (userAddress) => {
  // In a real application, you would filter posts based on the user's access level.
  // For now, we'll just return all posts.
  return posts;
};

const createPost = (post) => {
  posts.push(post);
  return post;
};

module.exports = {
  getAllPosts,
  createPost,
};
